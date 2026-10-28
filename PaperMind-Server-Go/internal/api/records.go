package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/aiclient"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// ── 记录组（records.go）────────────────────────────────────────────
// TS 源：reflections.ts（67）+ problem-logs.ts（70）+ problem-solving-logs.ts
//（211）+ control-center.ts（116）+ chat-sessions.ts（96）。
//
// 移植要点：
//   - 读路由的 guest 判定 `userId && userId !== 'guest'` 复用 notes.go 的
//     scopedUserID（auth 中间件从不产出字面 'guest'，guest 实际按
//     GUEST_UUID 过滤，详见 notes.go 文件头说明）
//   - 写路由 userId 兜底：reflections/problem-logs/problem-solving-logs/
//     control-center 是字面 'guest'（writeUserID）；chat-sessions 各路由是
//     'temp_user'（chatTempUserID），逐路由对照 TS
//   - maybeSingle 在 supabase-js 2.x 对 GET 用平铺 Accept + 客户端解包
//    （0 行→null）；db.Query.MaybeSingle 对 GET 发对象 Accept，PostgREST
//     0 行回 406 PGRST116（实测），会把 TS 的 404 变 500——因此 GET 单行
//     一律走 recordsMaybeSingleUnwrap（平铺 Accept 数组 + 客户端解包）
//   - problem-logs DELETE：TS 的 delete().select().single() 0 行 → 500
//    （PGRST116），'日志不存在' 404 分支在 TS 即为不可达防御代码；
//     db.Query.Delete 不带 Prefer: return=representation（204 空响应体），
//     拿不到被删行，故先以相同过滤条件查行、再删、响应回查到的行
//   - problem-solving-logs POST：related_draft_ids 列缺失（code 42703 或
//     错误消息含列名）时降级去掉该列重试（problem-solving-logs.ts:159-168）
//   - /summarize 响应是 {"data":..., "overwritten": bool} 双键；LLM 调用
//     经 internal/aiclient（缺 key 时 500 透传与 TS 逐字一致的文案）
//   - /stats 的 gte/lte 用 not.lt/not.gt 组合（db.Query 未导出 Gte/Lte，
//     PostgREST 语义 not.lt ≡ >=、not.gt ≡ <=，实测两写法结果一致）

// ═══ 路由注册 ═══

func registerRecordsRoutes(mux *http.ServeMux) {
	// ── /reflections（reflections.ts）──────────────────────────────
	mux.HandleFunc("GET /api/v1/reflections", handleReflectionsList)
	mux.HandleFunc("GET /api/v1/reflections/{id}", handleReflectionsGet)
	mux.HandleFunc("POST /api/v1/reflections", handleReflectionsCreate) // 201；period 必填

	// ── /problem-logs（problem-logs.ts；表 paper_problem_logs）─────
	mux.HandleFunc("GET /api/v1/problem-logs", handleProblemLogsList)
	mux.HandleFunc("POST /api/v1/problem-logs", handleProblemLogsCreate) // 201
	mux.HandleFunc("DELETE /api/v1/problem-logs/{id}", handleProblemLogsDelete)

	// ── /problem-solving-logs（problem-solving-logs.ts）────────────
	mux.HandleFunc("POST /api/v1/problem-solving-logs/summarize", handleProblemSolvingLogsSummarize)
	mux.HandleFunc("GET /api/v1/problem-solving-logs", handleProblemSolvingLogsList)
	mux.HandleFunc("POST /api/v1/problem-solving-logs", handleProblemSolvingLogsCreate)
	mux.HandleFunc("GET /api/v1/problem-solving-logs/stats", handleProblemSolvingLogsStats)

	// ── /control-center（control-center.ts）────────────────────────
	mux.HandleFunc("POST /api/v1/control-center/mark-viewed", handleControlCenterMarkViewed)
	mux.HandleFunc("GET /api/v1/control-center/recent-records", handleControlCenterRecentRecords)

	// ── /chat-sessions（chat-sessions.ts）──────────────────────────
	mux.HandleFunc("GET /api/v1/chat-sessions", handleChatSessionsList)
	mux.HandleFunc("POST /api/v1/chat-sessions", handleChatSessionsCreate)
	mux.HandleFunc("GET /api/v1/chat-sessions/{sessionId}/messages", handleChatSessionMessagesList)
	mux.HandleFunc("POST /api/v1/chat-sessions/{sessionId}/messages", handleChatSessionMessagesCreate)
}

// ═══ 通用助手 ═══

// chatTempUserID 是 chat-sessions 各路由的 userId 兜底字面量 'temp_user'
// （chat-sessions.ts:9/29/70，注意与其他路由的 'guest' 不同）。
const chatTempUserID = "temp_user"

// recordsMaybeSingleUnwrap 客户端侧复刻 supabase-js maybeSingle 对 GET 的
// 行为（postgrest-js 2.x：平铺 Accept 拿数组，0 行→null、1 行→该行）。
// 不用 db.Query.MaybeSingle：其对 GET 也发对象 Accept，PostgREST 在 0 行时
// 回 406 PGRST116（实测），等价于把 TS 的 404 分支变成 500。
// eq(id) 主键过滤下最多 1 行，>1 行的 PGRST116→500 分支不可达（与 TS 同）。
func recordsMaybeSingleUnwrap(rows json.RawMessage) (json.RawMessage, bool) {
	var arr []json.RawMessage
	if err := json.Unmarshal(rows, &arr); err != nil {
		return nil, false // 防御：非数组（平铺 Accept 下理论不可达）
	}
	if len(arr) == 0 {
		return nil, false
	}
	return arr[0], true
}

// dbErrorMessage 取 PostgREST 错误的原始 message（对应 TS 的 err.message；
// *db.PostgrestError.Error() 带 code 前缀，做列名/文案匹配时用原始 message）。
func dbErrorMessage(err error) string {
	var pErr *db.PostgrestError
	if errors.As(err, &pErr) {
		return pErr.Message
	}
	return err.Error()
}

// recordsDecodeBody 在共享 decodeJSONObjectBody 语义上补一个空请求体分支：
// express.json 把空 body 当 {} 处理，TS 的 chat-sessions POST /
// problem-solving-logs POST 无必填字段，空 body 会走默认值并 200；
// 直接 Decode 空 body 会报 EOF→400，状态码与 TS 不一致。
// 其余行为与共享助手一致：畸形 JSON → 400；数组/标量/null 按空对象
// （TS 解构出 undefined 字段的等价处理；null 在 TS 会 TypeError→500，
// 归为空对象属已知取舍，见 notes.go decodeJSONObjectBody 注释）。
func recordsDecodeBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	s := strings.TrimSpace(string(body))
	if s == "" {
		return map[string]any{}, true // express.json：空 body → {}
	}
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	m := map[string]any{}
	if s[0] == '{' {
		if err := json.Unmarshal(raw, &m); err != nil {
			Error(w, http.StatusBadRequest, err.Error())
			return nil, false
		}
	}
	return m, true
}

// parseJSDate 近似 new Date(str)：覆盖调用方实际会传的格式——RFC3339
// （含 Z / +00:00 / 小数秒，PostgREST 时间戳与 toISOString() 输出均在此列）、
// date-only（JS 按 UTC 解析）、无时区的 ISO 日期时间（JS 按本地时区）。
// 其余 JS 可解析的冷门格式（RFC2822 等）不支持，解析失败返回 TS 同款
// "Invalid time value"（TS 由 Invalid Date 的 toISOString 抛 RangeError）。
func parseJSDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999", // 无时区 → 本地（JS 语义）
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, nil
		}
	}
	if t, err := time.ParseInLocation("2006-01-02", s, time.UTC); err == nil {
		return t, nil // date-only：JS 按 UTC 零点解析
	}
	return time.Time{}, errors.New("Invalid time value")
}

// ═══ reflections（TS: reflections.ts）═══

// handleReflectionsList 获取所有反思（用户隔离）。对应 reflections.ts:9-22。
func handleReflectionsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableReflections).Select("*").Order("created_at", false)
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleReflectionsGet 获取单个反思（仅本人可读）。对应 reflections.ts:25-39。
func handleReflectionsGet(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableReflections).Select("*").Eq("id", r.PathValue("id"))
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context()) // 平铺 Accept + 客户端解包，见 recordsMaybeSingleUnwrap
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	row, found := recordsMaybeSingleUnwrap(rows)
	if !found {
		Error(w, http.StatusNotFound, "反思不存在")
		return
	}
	OK(w, row)
}

// handleReflectionsCreate 创建反思。对应 reflections.ts:42-65。
// period 必填（400 '时间段不能为空'）；四个文本字段走 `x || null`
// （空串/假值归一为 null）；成功 201。
func handleReflectionsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	period := body["period"]
	if !jsTruthy(period) {
		Error(w, http.StatusBadRequest, "时间段不能为空")
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableReflections).Single().Insert(r.Context(), map[string]any{
		"learning_behavior": jsOr(body["learning_behavior"], nil),
		"challenge_report":  jsOr(body["challenge_report"], nil),
		"thinking_pattern":  jsOr(body["thinking_pattern"], nil),
		"suggestion":        jsOr(body["suggestion"], nil),
		"period":            period,
		"user_id":           userId,
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// ═══ problem-logs（TS: problem-logs.ts；表 paper_problem_logs）═══

// handleProblemLogsList 获取所有问题日志（用户隔离）。对应 problem-logs.ts:9-25。
func handleProblemLogsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TablePaperProblemLogs).Select("*").Order("created_at", false)
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleProblemLogsCreate 创建问题日志。对应 problem-logs.ts:28-51。
// problem 必填（400 '问题描述不能为空'）；process/solution 空串→null；
// knowledge_node_ids 假值→[]；成功 201。user_id 落库供反思数据源采集。
func handleProblemLogsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	if !jsTruthy(body["problem"]) {
		Error(w, http.StatusBadRequest, "问题描述不能为空")
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TablePaperProblemLogs).Single().Insert(r.Context(), map[string]any{
		"problem":            body["problem"],
		"process":            jsOr(body["process"], nil),
		"solution":           jsOr(body["solution"], nil),
		"knowledge_node_ids": jsOr(body["knowledge_node_ids"], []any{}),
		"user_id":            userId,
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// handleProblemLogsDelete 删除问题日志（仅本人）。对应 problem-logs.ts:54-68。
//
// TS 是一条 delete().eq().select().single() 链：命中时 200 回被删行；0 行时
// PostgREST 按对象 Accept 回 406 PGRST116 → TS throw → 500（'日志不存在'
// 的 404 分支在 TS 即为不可达防御代码）。internal/db 的 Delete 不带
// Prefer: return=representation（删除后只有 204 空响应体、拿不到被删行），
// 故此处以相同过滤条件先查行（Single：0 行 406 → 500，同 TS）再删，
// 响应回查到的行——对外行为等价。已知差异：查与删之间存在极窄竞态窗口
// （并发删除时 Go 仍回 200 行数据，TS 会 500）。
func handleProblemLogsDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	uid, scoped := scopedUserID(auth.UserID(r.Context()))
	filtered := func() *db.Query {
		q := client.From(db.TablePaperProblemLogs).Eq("id", r.PathValue("id"))
		if scoped {
			q = q.Eq("user_id", uid)
		}
		return q
	}
	rows, err := filtered().Select("*").Single().Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error()) // 0 行：PGRST116 → 500（同 TS）
		return
	}
	if _, err := filtered().Delete(r.Context()); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// ═══ problem-solving-logs（TS: problem-solving-logs.ts）═══

// pslSummaryMessage 是 /summarize 请求体 messages 元素。role/content 用
// any 对齐 TS 的动态访问（m.role === 'user'、String(m.content || ”)）。
type pslSummaryMessage struct {
	Role    any `json:"role"`
	Content any `json:"content"`
}

// pslSummaryPromptTemplate 逐字复刻 problem-solving-logs.ts:14-29 的总结
// prompt 模板（%s 处插入对话 transcript）。
const pslSummaryPromptTemplate = `你是学习分析专家。以下是一名学生与智能导师的一段完整对话。请把这段对话总结为一份学习认知快照，严格输出 JSON（不要 markdown 代码块）：

对话：
%s

输出 JSON 字段要求：
{
  "question": "学生本次对话的核心问题（一句概括，50字内）",
  "summary": "200-300字总结：问题脉络（问过什么、按什么顺序、如何推进）+ 认知变化（从什么状态到什么状态）",
  "mastered": ["学生已掌握/理解正确的概念（最多5个，没有则空数组）"],
  "confusions": ["学生暴露出的混淆点/错误理解/薄弱环节（最多5个）"],
  "question_patterns": ["提问模式标签，从以下类型选1-3个：概念辨析型、公式推导型、错题复盘型、应用场景型、发散延伸型、记忆巩固型"],
  "open_questions": ["对话结束时仍未解决的疑问（没有则空数组）"],
  "knowledge_links": ["涉及的学科/领域标签（如：复分析、数理统计）"],
  "depth_score": 1到5的整数，评估追问深度（1=浅尝辄止，5=追根究底）
}`

// pslStringify 复刻 String(x)：null/undefined → ""，字符串原样，数字/布尔按
// JS 字面量。对象/数组在 JS 会得到 "[object Object]"/逗号拼接，此处取紧凑
// JSON——调用方（RN 客户端）只发字符串，属不可达分支，见交付说明。
func pslStringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// pslTruncateRunes 按 rune 截断，近似 JS slice(0, n) 的 UTF-16 码元语义
// （BMP 内 1 rune = 1 码元；增补平面字符 JS 会截出半个代理对，Go 按 rune
// 截断，差异只出现在截断点恰逢 emoji 的极端情况）。
func pslTruncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

// pslBuildSessionSummaryPrompt 复刻 problem-solving-logs.ts:10-30。
// role === 'user' 标「学生」，其余一律「导师」；content 假值归一空串。
func pslBuildSessionSummaryPrompt(messages []pslSummaryMessage) string {
	lines := make([]string, 0, len(messages))
	for _, m := range messages {
		role := "导师"
		if s, ok := m.Role.(string); ok && s == "user" {
			role = "学生"
		}
		lines = append(lines, role+"："+pslTruncateRunes(pslStringify(m.Content), 3000))
	}
	return strings.Replace(pslSummaryPromptTemplate, "%s", strings.Join(lines, "\n"), 1)
}

// pslExtractJSONObject 复刻 content.match(/\{[\s\S]*\}/)：首个 { 到最后
// 一个 } 的贪婪匹配。
func pslExtractJSONObject(s string) (string, bool) {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < start {
		return "", false
	}
	return s[start : end+1], true
}

// pslDepthScore 复刻 Math.max(1, Math.min(5, parseInt(parsed.depth_score) || 1))。
// 复用 notes.go 的 parseJSInt（parseInt 语义：十进制前缀、失败为 NaN）；
// NaN/非数值假值 → 1，最终夹在 [1,5]。
func pslDepthScore(v any) int {
	n := 1
	if s, ok := v.(string); ok {
		if iv, ok2 := parseJSInt(s).(int); ok2 {
			n = iv
		}
	} else if f, ok := v.(float64); ok {
		n = int(f) // parseInt(3.7)=3：向零截断
	}
	if n < 1 {
		n = 1
	}
	if n > 5 {
		n = 5
	}
	return n
}

// pslStringArray 复刻 arr(v)（problem-solving-logs.ts:62）：
// Array.isArray(v) ? v.map(String).slice(0,200).slice(0,5) : []。
// 始终返回非 nil 切片（JSON 编码为 [] 而非 null，TS 载数组列同形）。
func pslStringArray(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return []string{}
	}
	out := []string{}
	for i, el := range arr {
		if i >= 5 {
			break // slice(0,5)
		}
		out = append(out, pslTruncateRunes(pslStringify(el), 200))
	}
	return out
}

// pslSummaryPayload 是 /summarize 写库的载荷（migrations/006 的会话总结列）。
type pslSummaryPayload struct {
	UserID           string   `json:"user_id"`
	ChatSessionID    string   `json:"chat_session_id"`
	Question         string   `json:"question"`
	Answer           string   `json:"answer"`
	Mastered         []string `json:"mastered"`
	Confusions       []string `json:"confusions"`
	QuestionPatterns []string `json:"question_patterns"`
	OpenQuestions    []string `json:"open_questions"`
	KnowledgeLinks   []string `json:"knowledge_links"`
	DepthScore       int      `json:"depth_score"`
}

// pslBuildSummaryPayload 复刻 problem-solving-logs.ts:63-74 的载荷构建：
// question/answer 取假值归一空串并截断（200/4000）；六个数组走 arr()；
// depth_score 走 pslDepthScore。
func pslBuildSummaryPayload(userID, chatSessionID string, parsed map[string]any) pslSummaryPayload {
	return pslSummaryPayload{
		UserID:           userID,
		ChatSessionID:    chatSessionID,
		Question:         pslTruncateRunes(pslStringify(jsOr(parsed["question"], nil)), 200),
		Answer:           pslTruncateRunes(pslStringify(jsOr(parsed["summary"], nil)), 4000),
		Mastered:         pslStringArray(parsed["mastered"]),
		Confusions:       pslStringArray(parsed["confusions"]),
		QuestionPatterns: pslStringArray(parsed["question_patterns"]),
		OpenQuestions:    pslStringArray(parsed["open_questions"]),
		KnowledgeLinks:   pslStringArray(parsed["knowledge_links"]),
		DepthScore:       pslDepthScore(parsed["depth_score"]),
	}
}

// pslDecodeSummaryMessages 解出 messages 数组。TS 对字符串/数字元素取属性
// 得 undefined（角色→'导师'、内容→”）；null 元素抛 TypeError→500；Go 对
// 非对象元素统一按空消息处理（差异见交付说明）。
func pslDecodeSummaryMessages(raw any) []pslSummaryMessage {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	messages := make([]pslSummaryMessage, 0, len(arr))
	for _, el := range arr {
		var m pslSummaryMessage
		if obj, isObj := el.(map[string]any); isObj {
			b, _ := json.Marshal(obj)
			_ = json.Unmarshal(b, &m)
		}
		messages = append(messages, m)
	}
	return messages
}

// handleProblemSolvingLogsSummarize 「我明白了」升级版：完整对话 → tutor
// 总结 → 按会话覆盖入库。对应 problem-solving-logs.ts:33-107。
// 响应 200 {"data":..., "overwritten": bool} 双键。
func handleProblemSolvingLogsSummarize(w http.ResponseWriter, r *http.Request) {
	fail := func(err error) {
		log.Printf("[psl-summarize] Error: %v", err) // TS console.error('[psl-summarize] Error:', err.message)
		Error(w, http.StatusInternalServerError, err.Error())
	}
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	chatSessionID := body["chat_session_id"]
	messages := pslDecodeSummaryMessages(body["messages"])
	if !jsTruthy(chatSessionID) || len(messages) == 0 {
		Error(w, http.StatusBadRequest, "缺少 chat_session_id 或 messages")
		return
	}
	chatSessionIDStr := pslStringify(chatSessionID) // 非字符串值按 JS 字面量透传（同 TS eq/insert）

	// 1) tutor 对完整对话做结构化总结（思考模型，无正文时升档重试）
	prompt := pslBuildSessionSummaryPrompt(messages)
	cfg := config.Load()
	var content string
	for _, budget := range []int{4096, 16384} {
		resp, err := aiclient.CreateMessage(r.Context(), aiclient.Request{
			Model:       cfg.DefaultModel,
			MaxTokens:   budget,
			Temperature: 0.3,
			Messages:    []aiclient.InputMessage{{Role: "user", Content: prompt}},
		})
		if err != nil {
			fail(err) // 含缺 API key：文案与 TS 的 Proxy 抛错逐字一致
			return
		}
		content = strings.TrimSpace(resp.Text())
		if content != "" {
			break
		}
		log.Println("[psl-summarize] 无正文输出，升档重试")
	}
	obj, hasJSON := pslExtractJSONObject(content)
	if !hasJSON {
		fail(errors.New("总结响应无 JSON"))
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(obj), &parsed); err != nil {
		fail(err) // TS：JSON.parse 抛 SyntaxError → 500（错误文案随运行时而异）
		return
	}
	payload := pslBuildSummaryPayload(userId, chatSessionIDStr, parsed)

	client, ok := dbClient(w)
	if !ok {
		return
	}
	// 2) 覆盖制：同一会话只保留一条（唯一索引兜底冲突则更新）。
	// TS 对该查询只解构 data、丢弃 error，此处同样忽略错误走插入分支
	//（唯一索引冲突时由 insert 报错 → 500，与 TS 一致）。
	existingRows, _ := client.From(db.TableProblemSolvingLogs).
		Select("id").Eq("user_id", userId).Eq("chat_session_id", chatSessionIDStr).
		Limit(1).Rows(r.Context())
	var existing []struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(existingRows, &existing)

	var data json.RawMessage
	var err error
	if len(existing) > 0 {
		data, err = client.From(db.TableProblemSolvingLogs).
			Eq("id", strconv.Itoa(existing[0].ID)).Single().
			Update(r.Context(), payload)
	} else {
		data, err = client.From(db.TableProblemSolvingLogs).Single().
			Insert(r.Context(), payload)
	}
	if err != nil {
		fail(err)
		return
	}
	JSON(w, http.StatusOK, struct {
		Data        json.RawMessage `json:"data"`
		Overwritten bool            `json:"overwritten"`
	}{data, len(existing) > 0})
}

// handleProblemSolvingLogsList 获取所有问题解答日志（用户隔离）。
// 对应 problem-solving-logs.ts:110-126。
func handleProblemSolvingLogsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableProblemSolvingLogs).Select("*").Order("created_at", false)
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleProblemSolvingLogsCreate 创建问题解答日志（响应 200，非 201）。
// 对应 problem-solving-logs.ts:129-175。related_draft_ids 由 migrations/002
// 添加：未执行迁移的库返回 42703（或错误消息含列名），降级去掉该列重试。
func handleProblemSolvingLogsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}
	payload := map[string]any{
		"user_id":                    userId,
		"question":                   jsOr(body["question"], ""),
		"answer":                     jsOr(body["answer"], ""),
		"steps":                      jsOr(body["steps"], ""),
		"related_knowledge_node_ids": jsOr(body["related_knowledge_node_ids"], []any{}),
		"related_draft_ids":          jsOr(body["related_draft_ids"], []any{}),
		"citation_snippets":          jsOr(body["citation_snippets"], []any{}),
	}
	rows, err := client.From(db.TableProblemSolvingLogs).Single().Insert(r.Context(), payload)
	var pErr *db.PostgrestError
	isMissingColumn := errors.As(err, &pErr) && pErr.Code == "42703"
	if err != nil && (isMissingColumn || strings.Contains(dbErrorMessage(err), "related_draft_ids")) {
		delete(payload, "related_draft_ids")
		rows, err = client.From(db.TableProblemSolvingLogs).Single().Insert(r.Context(), payload)
		log.Println("[problem-solving-logs] related_draft_ids 列缺失，已降级写入" +
			"（执行 migrations/002_add_related_draft_ids.sql 可恢复）")
	}
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// recStatsDays 复刻 parseInt(req.query.days) || 30
// （problem-solving-logs.ts:181；parseInt("0")=0 为 JS 假值 → 30）。
func recStatsDays(s string) int {
	if v, ok := parseJSInt(s).(int); ok && v != 0 {
		return v
	}
	return 30
}

// recDailyStats 复刻 /stats 的按天统计（problem-solving-logs.ts:198-205）：
// 按行 created_at 的 UTC 日期计数；任一行无法解析则返回错误
// （TS 在 toISOString 处抛 "Invalid time value" → 500）。
func recDailyStats(createds []string) (map[string]int, error) {
	stats := map[string]int{}
	for _, c := range createds {
		t, err := parseJSDate(c)
		if err != nil {
			return nil, err
		}
		stats[t.UTC().Format("2006-01-02")]++
	}
	return stats, nil
}

// handleProblemSolvingLogsStats 获取统计数据（按时间段，endDate 锚定窗口
// 终点）。对应 problem-solving-logs.ts:178-209。响应
// {"data":{"total":n,"daily":{"YYYY-MM-DD":count,...}}}。
func handleProblemSolvingLogsStats(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	days := recStatsDays(q.Get("days"))
	end := time.Now()
	if raw := q.Get("endDate"); raw != "" {
		parsed, err := parseJSDate(raw)
		if err != nil {
			// TS：Invalid Date → toISOString() 抛 RangeError → 500（同款文案）
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		end = parsed
	}
	// TS：new Date(end - days*24h).toISOString()（UTC 毫秒精度、Z 结尾）
	startISO := end.UTC().Add(-time.Duration(days) * 24 * time.Hour).
		Format("2006-01-02T15:04:05.000Z")
	endISO := end.UTC().Format("2006-01-02T15:04:05.000Z")

	client, ok := dbClient(w)
	if !ok {
		return
	}
	// gte/lte 的等价写法：not.lt ≡ >=、not.gt ≡ <=（db.Query 未导出
	// Gte/Lte，Not 的 op 参数是公开的通用入口）
	query := client.From(db.TableProblemSolvingLogs).Select("created_at").
		Not("created_at", "lt", startISO).
		Not("created_at", "gt", endISO)
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var logs []struct {
		CreatedAt string `json:"created_at"`
	}
	if err := json.Unmarshal(rows, &logs); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	createds := make([]string, 0, len(logs))
	for _, lg := range logs {
		createds = append(createds, lg.CreatedAt)
	}
	daily, err := recDailyStats(createds)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Data(w, http.StatusOK, struct {
		Total int            `json:"total"`
		Daily map[string]int `json:"daily"`
	}{Total: len(logs), Daily: daily})
}

// ═══ control-center（TS: control-center.ts）═══

// recIDString 把 mark-viewed 的 id 归一为过滤字符串：字符串原样、数字按
// JS 字面量（5 → "5"，对应 TS eq('id', 5) 的 URL 形态），其余取字符串化。
func recIDString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return pslStringify(v)
}

// handleControlCenterMarkViewed 标记已读（清除红点）。
// 对应 control-center.ts:8-37，成功 {"success": true}。
func handleControlCenterMarkViewed(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	typ := body["type"]
	id := body["id"]
	if !jsTruthy(typ) || !jsTruthy(id) {
		Error(w, http.StatusBadRequest, "type and id are required")
		return
	}
	typeStr, _ := typ.(string)
	if typeStr != "study_note" && typeStr != "material" {
		Error(w, http.StatusBadRequest, `type must be "study_note" or "material"`)
		return
	}
	table := db.TableStudyNotes
	if typeStr != "study_note" {
		table = db.TableMaterials
	}
	client, ok := dbClient(w)
	if !ok {
		return
	}
	if _, err := client.From(table).
		Eq("id", recIDString(id)).
		Eq("user_id", userId).
		Update(r.Context(), map[string]any{"viewed_after_process": true}); err != nil {
		log.Printf("mark-viewed error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	SuccessTrue(w)
}

// recent-records 两表的查询列清单（逐字对照 control-center.ts:50/58/74/86；
// process_status 由 migrations/004 引入，legacy 版本用于缺列降级重查）。
const (
	recNoteColumns = "id, title, content, tags, logical_path, papercore, " +
		"ai_processed, viewed_after_process, process_status, created_at, updated_at"
	recNoteColumnsLegacy = "id, title, content, tags, logical_path, papercore, " +
		"ai_processed, viewed_after_process, created_at, updated_at"
	recMaterialColumns = "id, name, tags, logical_path, papercore, " +
		"ai_processed, viewed_after_process, process_status, created_at, updated_at"
	recMaterialColumnsLegacy = "id, name, tags, logical_path, papercore, " +
		"ai_processed, viewed_after_process, created_at, updated_at"
)

// recPerTableLimit 复刻 Math.min(parseInt(query.limit) || 50, 500)
// （control-center.ts:44）。"0" 的 parseInt=0 是 JS 假值 → 50；负数原样
// 透传（PostgREST 报错 → 500，同 TS）。
func recPerTableLimit(s string) int {
	n := 50
	if v, ok := parseJSInt(s).(int); ok && v != 0 {
		n = v
	}
	if n > 500 {
		n = 500
	}
	return n
}

// recRowsWithType 复刻 recent-records 的行改造：追加 record_type 字段
// （control-center.ts:98-102）。PostgREST 空结果 "[]" → 空切片。
func recRowsWithType(raw json.RawMessage, recordType string) ([]map[string]any, error) {
	rows := []map[string]any{}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	for _, row := range rows {
		row["record_type"] = recordType
	}
	return rows, nil
}

// recSortByCreatedAtDesc 复刻两表合并后的 created_at 倒序排序
// （control-center.ts:105-107）。解析失败的行按零值时间排末尾
// （TS 中 NaN 比较器结果未定义，此处取确定性语义）。时间与行先配对再
// 排序，避免排序中交换行导致的时间错位。
func recSortByCreatedAtDesc(rows []map[string]any) {
	type indexedRow struct {
		t   time.Time
		row map[string]any
	}
	items := make([]indexedRow, len(rows))
	for i, row := range rows {
		s, _ := row["created_at"].(string)
		t, err := parseJSDate(s)
		if err != nil {
			t = time.Time{}
		}
		items[i] = indexedRow{t: t, row: row}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].t.After(items[j].t) })
	for i, it := range items {
		rows[i] = it.row
	}
}

// handleControlCenterRecentRecords 合并返回最近的纪要与资料。
// 对应 control-center.ts:40-114。
func handleControlCenterRecentRecords(w http.ResponseWriter, r *http.Request) {
	userId := writeUserID(auth.UserID(r.Context()))
	limit := recPerTableLimit(r.URL.Query().Get("limit"))
	client, ok := dbClient(w)
	if !ok {
		return
	}

	// TS 用 Promise.all 并行两表查询；Go 顺序执行（无相互依赖，结果等价）
	notesRows, notesErr := client.From(db.TableStudyNotes).Select(recNoteColumns).
		Eq("user_id", userId).Order("created_at", false).Limit(limit).Rows(r.Context())
	if notesErr != nil && strings.Contains(dbErrorMessage(notesErr), "process_status") {
		notesRows, notesErr = client.From(db.TableStudyNotes).Select(recNoteColumnsLegacy).
			Eq("user_id", userId).Order("created_at", false).Limit(limit).Rows(r.Context())
	}
	matRows, matErr := client.From(db.TableMaterials).Select(recMaterialColumns).
		Eq("user_id", userId).Order("created_at", false).Limit(limit).Rows(r.Context())
	if matErr != nil && strings.Contains(dbErrorMessage(matErr), "process_status") {
		matRows, matErr = client.From(db.TableMaterials).Select(recMaterialColumnsLegacy).
			Eq("user_id", userId).Order("created_at", false).Limit(limit).Rows(r.Context())
	}
	if notesErr != nil {
		log.Printf("recent-records error: %v", notesErr)
		Error(w, http.StatusInternalServerError, notesErr.Error())
		return
	}
	if matErr != nil {
		log.Printf("recent-records error: %v", matErr)
		Error(w, http.StatusInternalServerError, matErr.Error())
		return
	}

	notes, err := recRowsWithType(notesRows, "study_note")
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	materials, err := recRowsWithType(matRows, "material")
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	combined := append(notes, materials...)
	recSortByCreatedAtDesc(combined)
	OK(w, combined)
}

// ═══ chat-sessions（TS: chat-sessions.ts）═══

// handleChatSessionsList 获取用户会话列表（恒按 user_id 过滤，含
// 'temp_user' 兜底）。对应 chat-sessions.ts:7-25。
func handleChatSessionsList(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" {
		userId = chatTempUserID
	}
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableChatSessions).Select("*").
		Eq("user_id", userId).Order("created_at", false).Limit(50).Rows(r.Context())
	if err != nil {
		log.Printf("Failed to get chat sessions: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleChatSessionsCreate 创建会话（title || '新对话'；响应 200 非 201）。
// 对应 chat-sessions.ts:28-46。
func handleChatSessionsCreate(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" {
		userId = chatTempUserID
	}
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableChatSessions).Single().Insert(r.Context(), map[string]any{
		"user_id": userId,
		"title":   jsOr(body["title"], "新对话"),
	})
	if err != nil {
		log.Printf("Failed to create chat session: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleChatSessionMessagesList 获取会话消息（created_at 升序，无用户过滤）。
// 对应 chat-sessions.ts:49-66。
func handleChatSessionMessagesList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableChatMessages).Select("*").
		Eq("session_id", r.PathValue("sessionId")).
		Order("created_at", true).Rows(r.Context())
	if err != nil {
		log.Printf("Failed to get messages: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleChatSessionMessagesCreate 保存一条会话消息（响应 200）。
// 对应 chat-sessions.ts:69-94。citations 假值→[]；role/content 未传时
// 省略键（等价 TS 的 undefined 被 JSON.stringify 丢弃、落列默认值），
// 显式 null 原样下发。
func handleChatSessionMessagesCreate(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" {
		userId = chatTempUserID
	}
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	client, ok := dbClient(w)
	if !ok {
		return
	}
	payload := map[string]any{
		"session_id": r.PathValue("sessionId"),
		"user_id":    userId,
		"citations":  jsOr(body["citations"], []any{}),
	}
	for _, key := range []string{"role", "content"} {
		if v, exists := body[key]; exists {
			payload[key] = v
		}
	}
	rows, err := client.From(db.TableChatMessages).Single().Insert(r.Context(), payload)
	if err != nil {
		log.Printf("Failed to save message: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}
