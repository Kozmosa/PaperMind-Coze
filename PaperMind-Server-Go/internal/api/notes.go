package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/retrieval"
)

// ── 笔记/社区组（notes.go）─────────────────────────────────────────
// TS 源：knowledge-nodes.ts（123 行）+ draft-pool.ts（89 行）+
// stickynotes.ts（66 行）+ forums.ts（82 行）+ papernote-style.ts（141 行）+
// study-notes.ts（140 行），外加 papernote-style /extract 依赖的
// utils/note-preferences.ts（152 行；refine-note 在 ai.ts 也引用同一实现，
// 本文件的 notePref* 函数为组内共用，AI 组可直接调用，勿重复实现）。
//
// 响应形状与状态码逐路由对照 TS：
//   - 列表/详情成功 200 {"data": ...}，创建成功 201（study-notes 例外，
//     其 POST/PUT 返回 200）；失败 {"error": msg}
//   - study-notes DELETE 返回 {"success": true}，其余 DELETE 返回 {"data": 行}
//   - 查询结果以 PostgREST 返回的原始 JSON 透传（不经过 Go 结构体重组），
//     列名、列序、时间戳格式与 TS 侧 supabase-js 透传完全一致
//   - maybeSingle() 0 行 → 404（GET 单行一律平铺 Accept 数组 + 客户端
//     解包，见 records 组的 recordsMaybeSingleUnwrap：db.Query.MaybeSingle
//     对 GET 发对象 Accept，PostgREST 0 行回 406 PGRST116（实测）会把
//     404 变 500）；.select().single() 尾链 0 行时
//     supabase-js 返回 PGRST116 error → TS throw → 500（各路由的 404
//     分支实为不可达的防御代码，此处同样保留）
//
// guest 语义（重要，与 PORTING.md:60 的建议写法不同）：
// TS auth 中间件给 guest 注入的是 GUEST_UUID（auth.ts:4 的
// '11111111-1111-1111-1111-111111111111'），从不是字面 'guest'；路由里的
// `userId !== 'guest'` 判定因此对 guest 恒为真——guest 实际按 GUEST_UUID
// 过滤数据（演示种子正挂在该 ID 下，见 seed-scenario.ts:40）。若按
// PORTING.md 建议的 `uid != auth.GuestUserID` 写，guest 会看到全部用户
// 数据，与 TS 实际行为相反；PORTING.md 第 3 行自认事实源是 server/src/，
// 故此处按 TS 源码以字面 "guest" 比较。

// tsGuestLiteral 是 TS 路由里的字面 'guest' 字符串（auth 中间件从不产出
// 该值，仅作防御性比较保留，行为对等 TS）。
const tsGuestLiteral = "guest"

// indexRebuildDelay 对应 knowledge-nodes.ts 中 scheduleIndexRebuild() 的
// 默认 5s 防抖窗口（index-refresh.ts:7）。
const indexRebuildDelay = 5 * time.Second

// dbClient 取 PostgREST 客户端：TS 各路由文件在模块顶层取
// getSupabaseClient()（缺凭据时模块加载即抛错、进程无法启动）；Go 侧
// 按架构师约定惰性初始化（PORTING.md:68-69），缺凭据时进程照常启动、
// 请求到达该路由时统一 500 {"error": ...}。
func dbClient(w http.ResponseWriter) (*db.Client, bool) {
	c, err := db.Get()
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return nil, false
	}
	return c, true
}

// scopedUserID 复刻读路由判定 `if (userId && userId !== 'guest')`
// （knowledge-nodes.ts:18、draft-pool.ts:13、study-notes.ts:13/30）：
// 返回 (uid, true) 表示查询需追加 eq(user_id, uid)。
func scopedUserID(uid string) (string, bool) {
	if uid == "" || uid == tsGuestLiteral {
		return "", false
	}
	return uid, true
}

// writeUserID 复刻写路由兜底 `(req as any).userId || 'guest'`
// （knowledge-nodes.ts:51、draft-pool.ts:29、study-notes.ts:44/78/126）。
func writeUserID(uid string) string {
	if uid == "" {
		return tsGuestLiteral
	}
	return uid
}

// ── JS 语义帮助函数（对齐 TS 动态类型的边界行为）──────────────────

// jsTruthy 复刻 JS truthiness：undefined/null/false/0/""/NaN 为假，
// 空数组与空对象为真（JSON 解码后 [] / {} 均为非 nil 容器）。
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any, map[string]any:
		return true
	default:
		return true
	}
}

// jsOr 复刻 `a || b`：a 为 JS 假值时返回 b，否则原样返回 a
// （TS 写法如 `short_name || ”`、`file_url || null`、`tags || []`）。
func jsOr(v, fallback any) any {
	if jsTruthy(v) {
		return v
	}
	return fallback
}

// jsNowISO 复刻 new Date().toISOString()：毫秒精度 UTC、Z 结尾
// （knowledge-nodes.ts:88、papernote-style.ts:43/124、study-notes.ts:95）。
func jsNowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// decodeJSONObjectBody 对应 express.json() + 路由顶部解构 req.body。
// 成功返回请求体对象（JSON null/数组/标量按空对象处理——TS 对数组/标量
// 解构出 undefined 字段等价于此；对 null 会抛 TypeError→500，此处一并
// 归为空对象，差异见交付说明）。解析失败统一 400 {"error": ...}
// （TS 侧为 express 默认 400 HTML 错误页，属框架层差异）。
func decodeJSONObjectBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	m := map[string]any{}
	if s := strings.TrimSpace(string(raw)); s != "" && s != "null" && s[0] == '{' {
		if err := json.Unmarshal(raw, &m); err != nil {
			Error(w, http.StatusBadRequest, err.Error())
			return nil, false
		}
	}
	return m, true
}

// isJSONNull 判定 PostgREST 对象 Accept 下的字面 null（MaybeSingle 0 行）。
func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// parseJSInt 对应 forums.ts:68 的 parseInt(String(req.params.forumId))：
// 解析十进制前缀（parseInt("12abc")=12、parseInt("12.9")=12），无数字
// 返回 nil——JSON 序列化为 null，等价 JS 的 NaN→null，由 forum_id 的
// 非空约束在 DB 侧报错→500。已知差异：JS parseInt 还认 "0x" 十六进制
// 前缀与超出 int64 的大数（浮点化），此处分别按 0 / null 处理。
func parseJSInt(s string) any {
	i := 0
	for i < len(s) && isJSWhitespace(s[i]) {
		i++
	}
	start := i
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == digits {
		return nil // NaN
	}
	n, err := strconv.Atoi(s[start:i])
	if err != nil {
		return nil // 溢出按 NaN 处理
	}
	return n
}

func isJSWhitespace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}

// cleanNoteTags 对应 study-notes.ts:49/92 的
// `(tags || []).map(t => t.replace(/^#/, ”).trim()).filter(Boolean)`。
// TS 中元素非字符串会抛 TypeError（t.replace is not a function）→
// catch-all 500，Go 侧等价返回错误由调用方 500。
func cleanNoteTags(raw any) ([]string, error) {
	if !jsTruthy(raw) {
		return []string{}, nil
	}
	arr, ok := raw.([]any)
	if !ok {
		// TS：非数组上调用 .map 抛 TypeError → 500
		return nil, errors.New("tags.map is not a function")
	}
	out := []string{}
	for _, el := range arr {
		s, ok := el.(string)
		if !ok {
			return nil, errors.New("t.replace is not a function")
		}
		s = strings.TrimPrefix(s, "#") // replace(/^#/, '')：仅去掉首个前导 #
		s = strings.TrimSpace(s)
		if s != "" { // filter(Boolean)
			out = append(out, s)
		}
	}
	return out, nil
}

// ═══ 路由注册 ═══

func registerNotesRoutes(mux *http.ServeMux) {
	// ── /knowledge-nodes（knowledge-nodes.ts）───────────────────────
	mux.HandleFunc("GET /api/v1/knowledge-nodes", handleKnowledgeNodesList)
	mux.HandleFunc("GET /api/v1/knowledge-nodes/{id}", handleKnowledgeNodesGet)
	mux.HandleFunc("POST /api/v1/knowledge-nodes", handleKnowledgeNodesCreate)
	mux.HandleFunc("PUT /api/v1/knowledge-nodes/{id}", handleKnowledgeNodesUpdate)
	mux.HandleFunc("DELETE /api/v1/knowledge-nodes/{id}", handleKnowledgeNodesDelete)

	// ── /draft-pool（draft-pool.ts）────────────────────────────────
	mux.HandleFunc("GET /api/v1/draft-pool", handleDraftPoolList)
	mux.HandleFunc("POST /api/v1/draft-pool", handleDraftPoolCreate)
	mux.HandleFunc("PATCH /api/v1/draft-pool/{id}", handleDraftPoolPatch)
	mux.HandleFunc("DELETE /api/v1/draft-pool/{id}", handleDraftPoolDelete)

	// ── /stickynotes（stickynotes.ts）──────────────────────────────
	mux.HandleFunc("GET /api/v1/stickynotes", handleStickynotesList)
	mux.HandleFunc("POST /api/v1/stickynotes", handleStickynotesCreate)
	mux.HandleFunc("DELETE /api/v1/stickynotes/{id}", handleStickynotesDelete)

	// ── /forums（forums.ts）────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/forums", handleForumsList)
	mux.HandleFunc("POST /api/v1/forums", handleForumsCreate)
	mux.HandleFunc("GET /api/v1/forums/{forumId}/posts", handleForumPostsList)
	mux.HandleFunc("POST /api/v1/forums/{forumId}/posts", handleForumPostsCreate)

	// ── /papernote-style（papernote-style.ts）──────────────────────
	mux.HandleFunc("GET /api/v1/papernote-style", handlePapernoteStyleGet)
	mux.HandleFunc("PUT /api/v1/papernote-style", handlePapernoteStylePut)
	mux.HandleFunc("POST /api/v1/papernote-style/extract", handlePapernoteStyleExtract)

	// ── /study-notes（study-notes.ts）──────────────────────────────
	mux.HandleFunc("GET /api/v1/study-notes/{id}", handleStudyNotesGet)
	mux.HandleFunc("GET /api/v1/study-notes", handleStudyNotesList)
	mux.HandleFunc("POST /api/v1/study-notes", handleStudyNotesCreate)
	mux.HandleFunc("PUT /api/v1/study-notes/{id}", handleStudyNotesUpdate)
	mux.HandleFunc("DELETE /api/v1/study-notes/{id}", handleStudyNotesDelete)
}

// ═══ knowledge-nodes（TS: knowledge-nodes.ts）═══

// handleKnowledgeNodesList 获取所有知识节点（支持用户隔离）。
// 对应 knowledge-nodes.ts:10-27。
func handleKnowledgeNodesList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableKnowledgeNodes).Select("*").Order("created_at", false)
	// 只对已登录用户过滤数据（guest 按 GUEST_UUID 隔离，见文件头说明）
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

// handleKnowledgeNodesGet 获取单个知识节点（maybeSingle 0 行 → 404）。
// 对应 knowledge-nodes.ts:30-43。
func handleKnowledgeNodesGet(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	// 不用 MaybeSingle（对象 Accept）：PostgREST 0 行回 406 PGRST116（实测），
	// 会把 TS 的 404 变 500——平铺 Accept 数组 + 客户端解包，同 records 组
	// recordsMaybeSingleUnwrap（notes.go 属笔记组，借用同包助手，见其注释）。
	rows, err := client.From(db.TableKnowledgeNodes).Select("*").
		Eq("id", r.PathValue("id")).Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	row, found := recordsMaybeSingleUnwrap(rows)
	if !found {
		Error(w, http.StatusNotFound, "节点不存在")
		return
	}
	OK(w, row)
}

// handleKnowledgeNodesCreate 创建知识节点（201 + 触发索引防抖重建）。
// 对应 knowledge-nodes.ts:46-73。
func handleKnowledgeNodesCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	papercore := body["papercore"]
	if !jsTruthy(papercore) {
		Error(w, http.StatusBadRequest, "Papercore 不能为空")
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableKnowledgeNodes).Single().Insert(r.Context(), map[string]any{
		"papercore":          papercore,
		"short_name":         jsOr(body["short_name"], ""),
		"original_file":      jsOr(body["original_file"], nil),
		"tags":               jsOr(body["tags"], []any{}),
		"relations":          jsOr(body["relations"], map[string]any{}),
		"attached_draft_ids": jsOr(body["attached_draft_ids"], []any{}),
		"parent_id":          jsOr(body["parent_id"], nil),
		"user_id":            userId,
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	Created(w, rows)
}

// handleKnowledgeNodesUpdate 更新知识节点（undefined 字段不写入 + updated_at）。
// 对应 knowledge-nodes.ts:76-103。
func handleKnowledgeNodesUpdate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	updateData := map[string]any{"updated_at": jsNowISO()}
	for _, key := range []string{
		"papercore", "short_name", "original_file", "tags",
		"relations", "attached_draft_ids", "parent_id",
	} {
		if v, exists := body[key]; exists {
			updateData[key] = v
		}
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableKnowledgeNodes).Eq("id", r.PathValue("id")).
		Single().Update(r.Context(), updateData)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "节点不存在")
		return
	}
	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	OK(w, rows)
}

// handleKnowledgeNodesDelete 删除知识节点（single 0 行时 supabase-js 报
// PGRST116 → TS throw → 500；404 分支与 TS 同为不可达防御代码）。
// 对应 knowledge-nodes.ts:106-121。
func handleKnowledgeNodesDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableKnowledgeNodes).Eq("id", r.PathValue("id")).
		Single().Delete(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "节点不存在")
		return
	}
	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	OK(w, rows)
}

// ═══ draft-pool（TS: draft-pool.ts）═══

// handleDraftPoolList 获取所有草稿（支持用户隔离）。对应 draft-pool.ts:9-22。
func handleDraftPoolList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableDraftPool).Select("*").Order("created_at", false)
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

// handleDraftPoolCreate 创建草稿（status 固定 unprocessed）。对应 draft-pool.ts:25-48。
func handleDraftPoolCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	content := body["content"]
	if !jsTruthy(content) {
		Error(w, http.StatusBadRequest, "内容不能为空")
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableDraftPool).Single().Insert(r.Context(), map[string]any{
		"content":           content,
		"file_url":          jsOr(body["file_url"], nil),
		"file_name":         jsOr(body["file_name"], nil),
		"status":            "unprocessed",
		"notification_sent": false,
		"user_id":           userId,
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// handleDraftPoolPatch 更新草稿状态。对应 draft-pool.ts:51-70。
// 注意 TS 用 truthiness 判 status（`if (status)`，空串/0/null 均不写入）、
// 用 !== undefined 判 notification_sent（false 也会写入）；空 updateData
// 照发 PATCH（PostgREST 返回匹配行原值），与 TS 一致。
func handleDraftPoolPatch(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	updateData := map[string]any{}
	if v, exists := body["status"]; exists && jsTruthy(v) {
		updateData["status"] = v
	}
	if v, exists := body["notification_sent"]; exists {
		updateData["notification_sent"] = v
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableDraftPool).Eq("id", r.PathValue("id")).
		Single().Update(r.Context(), updateData)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "草稿不存在")
		return
	}
	OK(w, rows)
}

// handleDraftPoolDelete 删除草稿。对应 draft-pool.ts:73-87。
func handleDraftPoolDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableDraftPool).Eq("id", r.PathValue("id")).
		Single().Delete(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "草稿不存在")
		return
	}
	OK(w, rows)
}

// ═══ stickynotes（TS: stickynotes.ts）═══

// handleStickynotesList 获取便利贴列表（支持按可见范围过滤）。
// 对应 stickynotes.ts:9-24（无用户隔离，仅 ?visibility= 过滤）。
func handleStickynotesList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableStickynotes).Select("*").Order("created_at", false)
	if visibility := r.URL.Query().Get("visibility"); visibility != "" {
		query = query.Eq("visibility", visibility)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleStickynotesCreate 创建便利贴。对应 stickynotes.ts:27-47。
func handleStickynotesCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	papercore := body["papercore"]
	if !jsTruthy(papercore) {
		Error(w, http.StatusBadRequest, "内容不能为空")
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableStickynotes).Single().Insert(r.Context(), map[string]any{
		"papercore":         papercore,
		"original_material": jsOr(body["original_material"], nil),
		"visibility":        jsOr(body["visibility"], "public"),
		"author_name":       jsOr(body["author_name"], "匿名用户"),
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// handleStickynotesDelete 删除便利贴。对应 stickynotes.ts:50-64。
func handleStickynotesDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableStickynotes).Eq("id", r.PathValue("id")).
		Single().Delete(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "便利贴不存在")
		return
	}
	OK(w, rows)
}

// ═══ forums（TS: forums.ts）═══

// handleForumsList 获取所有论坛（created_at 升序，与列表路由的降序不同）。
// 对应 forums.ts:11-22。
func handleForumsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableForums).Select("*").Order("created_at", true).
		Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleForumsCreate 创建论坛。对应 forums.ts:25-40。
func handleForumsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	name, typ := body["name"], body["type"]
	if !jsTruthy(name) || !jsTruthy(typ) {
		Error(w, http.StatusBadRequest, "名称和类型不能为空")
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableForums).Single().Insert(r.Context(), map[string]any{
		"name":        name,
		"type":        typ,
		"description": jsOr(body["description"], nil),
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// handleForumPostsList 获取某论坛的帖子（created_at 降序）。
// 对应 forums.ts:45-57：forum_id 以字符串直传 PostgREST（非法值由
// int 列 eq 比较在 DB 侧报错 → 500，与 TS 一致）。
func handleForumPostsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableForumPosts).Select("*").
		Eq("forum_id", r.PathValue("forumId")).Order("created_at", false).
		Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleForumPostsCreate 创建帖子。对应 forums.ts:60-80。
func handleForumPostsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	title, content := body["title"], body["content"]
	if !jsTruthy(title) || !jsTruthy(content) {
		Error(w, http.StatusBadRequest, "标题和内容不能为空")
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableForumPosts).Single().Insert(r.Context(), map[string]any{
		"forum_id":    parseJSInt(r.PathValue("forumId")),
		"title":       title,
		"content":     content,
		"author_name": jsOr(body["author_name"], "匿名用户"),
	})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	Created(w, rows)
}

// ═══ papernote-style（TS: papernote-style.ts）═══

// handlePapernoteStyleGet 获取当前用户的笔记风格偏好。
// 对应 papernote-style.ts:15-32：未登录返回 {"data":null}（200），
// 无记录同样返回 {"data":null}；命中时原样透传 DB 首行（不经结构体
// 重组，保持列序与未知列）。
func handlePapernoteStyleGet(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" || userId == tsGuestLiteral {
		OK(w, nil)
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TablePapernoteStyle).Select("*").
		Eq("user_id", userId).Limit(1).Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(rows, &arr); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(arr) == 0 {
		OK(w, nil)
		return
	}
	OK(w, arr[0])
}

// handlePapernoteStylePut 创建或更新当前用户的笔记风格偏好。
// 对应 papernote-style.ts:35-81：先查已有记录，有则 update、无则 insert。
func handlePapernoteStylePut(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" || userId == tsGuestLiteral {
		Error(w, http.StatusUnauthorized, "需要登录")
		return
	}

	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	updateData := map[string]any{"updated_at": jsNowISO()}
	if v, exists := body["general_preference"]; exists {
		updateData["general_preference"] = v
	}
	if v, exists := body["subject_preferences"]; exists {
		updateData["subject_preferences"] = v
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	// 查找当前用户的已有记录（TS 未检查该查询的 error，只解构 data；
	// 出错时按无记录处理走 insert 分支，由后续写入错误统一 500）
	rows, err := client.From(db.TablePapernoteStyle).Select("id").
		Eq("user_id", userId).Limit(1).Rows(r.Context())
	if err != nil {
		rows = nil
	}
	var existing []struct {
		ID int `json:"id"`
	}
	_ = json.Unmarshal(rows, &existing)

	var result json.RawMessage
	if len(existing) > 0 {
		result, err = client.From(db.TablePapernoteStyle).Eq("id", strconv.Itoa(existing[0].ID)).
			Single().Update(r.Context(), updateData)
	} else {
		result, err = client.From(db.TablePapernoteStyle).Single().Insert(r.Context(), map[string]any{
			"user_id":             userId,
			"general_preference":  jsOr(body["general_preference"], ""),
			"subject_preferences": jsOr(body["subject_preferences"], map[string]any{}),
		})
	}
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, result)
}

// handlePapernoteStyleExtract 从修正指令中提取偏好并合并存储。
// 对应 papernote-style.ts:84-139：LLM 提取（失败回退关键词）→ 按学科
// 分层合并 → 仅在提取到偏好时写库（TS 不解构写库的 error，失败静默）。
func handlePapernoteStyleExtract(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context())
	if userId == "" || userId == tsGuestLiteral {
		Error(w, http.StatusUnauthorized, "需要登录")
		return
	}

	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	refinementPrompt := body["refinementPrompt"]
	if !jsTruthy(refinementPrompt) {
		Error(w, http.StatusBadRequest, "缺少修正指令")
		return
	}
	// TS 将任意值经模板字符串送入 LLM（`${refinementPrompt}`）；非字符串
	// 的 truthy 值此处按 JSON 编码近似字符串化（JS 的 String() 会产出
	// "[object Object]" 之类，属框架级差异，正常客户端只发字符串）
	prompt, isStr := refinementPrompt.(string)
	if !isStr {
		b, _ := json.Marshal(refinementPrompt)
		prompt = strings.Trim(string(b), `"`)
	}

	// 提取偏好（LLM 优先，失败回退关键词；与 refine-note 共用同一实现）
	extracted := notePrefExtract(r.Context(), prompt)
	extractedPrefs := extracted.preferences
	if extractedPrefs == nil {
		extractedPrefs = map[string]any{}
	}
	subject := extracted.subject

	client, ok := dbClient(w)
	if !ok {
		return
	}
	// 合并到已有偏好（按学科分层写入 subject_preferences，兼容旧平铺数据）
	rows, err := client.From(db.TablePapernoteStyle).Select("*").
		Eq("user_id", userId).Limit(1).Rows(r.Context())
	if err != nil {
		// 同 TS：该查询 error 未检查，出错时 existing 按空处理
		rows = nil
	}
	var existing []struct {
		ID                 int            `json:"id"`
		SubjectPreferences map[string]any `json:"subject_preferences"`
	}
	_ = json.Unmarshal(rows, &existing)

	existingPrefs := map[string]any{}
	if len(existing) > 0 && existing[0].SubjectPreferences != nil {
		existingPrefs = existing[0].SubjectPreferences
	}

	var mergedPrefs map[string]any
	if len(extractedPrefs) > 0 {
		mergedPrefs = notePrefMerge(existingPrefs, subject, extractedPrefs)
	} else {
		mergedPrefs = notePrefNormalize(existingPrefs)
	}

	if len(extractedPrefs) > 0 {
		if len(existing) > 0 {
			// TS：update 无 .select() 尾链且不解构 error——写失败静默
			_, _ = client.From(db.TablePapernoteStyle).Eq("id", strconv.Itoa(existing[0].ID)).
				Update(r.Context(), map[string]any{
					"subject_preferences": mergedPrefs,
					"updated_at":          jsNowISO(),
				})
		} else {
			_, _ = client.From(db.TablePapernoteStyle).Insert(r.Context(), map[string]any{
				"user_id":             userId,
				"subject_preferences": mergedPrefs,
			})
		}
	}

	OK(w, struct {
		Extracted map[string]any `json:"extracted"`
		Subject   string         `json:"subject"`
		Merged    map[string]any `json:"merged"`
	}{extractedPrefs, subject, mergedPrefs})
}

// ═══ study-notes（TS: study-notes.ts）═══

// handleStudyNotesGet 获取单个学习纪要（single 0 行 → PGRST116 error → 500，
// 与 TS 一致；404 分支同为不可达防御代码）。对应 study-notes.ts:9-23。
func handleStudyNotesGet(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableStudyNotes).Select("*").Eq("id", r.PathValue("id"))
	if uid, ok := scopedUserID(auth.UserID(r.Context())); ok {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Single().Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		Error(w, http.StatusNotFound, "Study note not found")
		return
	}
	OK(w, rows)
}

// handleStudyNotesList 获取所有学习纪要。对应 study-notes.ts:26-39。
func handleStudyNotesList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableStudyNotes).Select("*").Order("created_at", false)
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

// handleStudyNotesCreate 创建学习纪要。对应 study-notes.ts:42-73。
// 注意：POST 返回 200（非 201）；可选列仅在请求体包含时写入
// （避免数据库列不存在时报错）；tags 清洗 # 前缀。
func handleStudyNotesCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	cleanTags, err := cleanNoteTags(body["tags"])
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	insertData := map[string]any{
		"user_id":              userId,
		"title":                jsOr(body["title"], "未命名纪要"),
		"content":              jsOr(body["content"], ""),
		"tags":                 cleanTags,
		"ai_processed":         false,
		"viewed_after_process": false,
	}
	// 仅当请求体中包含该字段时才写入（避免数据库列不存在时报错）
	for _, key := range []string{"knowledge_node_id", "file_url", "file_name", "logical_path"} {
		if v, exists := body[key]; exists {
			insertData[key] = jsOr(v, nil)
		}
	}
	if v, exists := body["blocks"]; exists {
		insertData["blocks"] = v
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableStudyNotes).Single().Insert(r.Context(), insertData)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleStudyNotesUpdate 更新学习纪要（user_id 一并作为过滤条件）。
// 对应 study-notes.ts:76-121。注意 logical_path 原样写入（不 `|| null`，
// 与 POST 分支不同）；cleanTags 无条件计算但仅 tags 存在时写入。
func handleStudyNotesUpdate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	cleanTags, err := cleanNoteTags(body["tags"])
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	updateData := map[string]any{"updated_at": jsNowISO()}
	if v, exists := body["title"]; exists {
		updateData["title"] = v
	}
	if v, exists := body["content"]; exists {
		updateData["content"] = v
	}
	if v, exists := body["knowledge_node_id"]; exists {
		updateData["knowledge_node_id"] = jsOr(v, nil)
	}
	if _, exists := body["tags"]; exists {
		updateData["tags"] = cleanTags
	}
	for _, key := range []string{
		"processed", "papercore", "logical_path",
		"ai_processed", "viewed_after_process", "blocks",
	} {
		if v, exists := body[key]; exists {
			updateData[key] = v
		}
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableStudyNotes).
		Eq("id", r.PathValue("id")).Eq("user_id", userId).
		Single().Update(r.Context(), updateData)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleStudyNotesDelete 删除学习纪要（无 .select() 尾链 → 无行也 200）。
// 对应 study-notes.ts:124-138。
func handleStudyNotesDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	_, err := client.From(db.TableStudyNotes).
		Eq("id", r.PathValue("id")).Eq("user_id", userId).
		Delete(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	SuccessTrue(w)
}

// ═══ note-preferences.ts 等价物（papernote-style /extract 与 ai.ts
// refine-note 共用，AI 组请直接调用以下 notePref* 函数，勿重复实现）═══

// notePrefGeneralSubject 对应 note-preferences.ts:13 的 GENERAL_SUBJECT。
const notePrefGeneralSubject = "通用"

// notePrefExtraction 对应 TS 的 ExtractedNotePreference | null：
// found=false ⇔ TS 返回 null（指令中无可提取偏好，调用方跳过写库）。
type notePrefExtraction struct {
	subject     string
	preferences map[string]any
	found       bool
}

// notePrefExtractByKeywords 对应 note-preferences.ts:21-36 的关键词规则
// （LLM 失败时的回退路径）。中文关键词不受 toLowerCase 影响，原样保留
// 该调用以对齐 TS。
func notePrefExtractByKeywords(refinementPrompt string) map[string]any {
	prefs := map[string]any{}
	prompt := strings.ToLower(refinementPrompt)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(prompt, w) {
				return true
			}
		}
		return false
	}
	if has("详细", "展开", "更多") {
		prefs["detail_level"] = "high"
	}
	if has("简洁", "简短", "概括") {
		prefs["detail_level"] = "concise"
	}
	if has("表格", "对比") {
		prefs["prefer_tables"] = true
	}
	if has("例子", "示例", "举例") {
		prefs["prefer_examples"] = true
	}
	if has("重点", "突出", "强调") {
		prefs["emphasize_keypoints"] = true
	}
	if has("通俗", "简单", "易懂") {
		prefs["language_style"] = "plain"
	}
	return prefs
}

// notePrefNormalize 对应 note-preferences.ts:107-122：把 subject_preferences
// 统一为学科分层结构。旧平铺结构（值为标量/数组）归入「通用」层，已是
// 分层的原样保留；「通用」层已有值覆盖平铺同名键（{...flat, ...layered}）。
// 非对象输入（null/数组/标量）返回空对象。
func notePrefNormalize(raw any) map[string]any {
	m, ok := raw.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	layered := map[string]any{}
	flat := map[string]any{}
	for k, v := range m {
		if vm, isObj := v.(map[string]any); isObj {
			layered[k] = vm
		} else {
			flat[k] = v
		}
	}
	if len(flat) > 0 {
		merged := map[string]any{}
		for k, v := range flat {
			merged[k] = v
		}
		if gen, ok := layered[notePrefGeneralSubject].(map[string]any); ok {
			for k, v := range gen {
				merged[k] = v
			}
		}
		layered[notePrefGeneralSubject] = merged
	}
	return layered
}

// notePrefMerge 对应 note-preferences.ts:125-134：按学科 key 合并新偏好，
// 新值覆盖旧值，返回可写回 subject_preferences 的分层对象。
func notePrefMerge(raw any, subject string, preferences map[string]any) map[string]any {
	layered := notePrefNormalize(raw)
	key := strings.TrimSpace(subject)
	if key == "" {
		key = notePrefGeneralSubject
	}
	merged := map[string]any{}
	if base, ok := layered[key].(map[string]any); ok {
		for k, v := range base {
			merged[k] = v
		}
	}
	for k, v := range preferences {
		merged[k] = v
	}
	layered[key] = merged
	return layered
}

// notePrefLLMSystemPrompt 逐字复刻 note-preferences.ts:54-68 的 system
// 提示词。papernote-style /extract 不传 subjectHints，对应模板中
// hints=[] 的展开（「学科判断：」后直接接「能判断则填学科名…」）；
// refine-note 若带 hints 调用需另拼该段（ai.ts 侧自行展开）。
const notePrefLLMSystemPrompt = `你是笔记偏好分析助手。用户正在修正一份 AI 生成的学习笔记，请从修正指令中提取用户的笔记风格偏好，并判断偏好所属的学科。

可选偏好键（只输出用户明确表达或强烈暗示的）：
- detail_level: "high"（更详细/展开）或 "concise"（更简洁/概括）
- prefer_tables: true（偏好表格/对比）
- prefer_examples: true（偏好例子/示例）
- emphasize_keypoints: true（偏好突出重点）
- language_style: "plain"（通俗易懂）或 "formal"（严谨正式）
- custom: 字符串，描述其他不好归类的偏好（可选）

学科判断：能判断则填学科名（如 "数学"），无法判断填 "` + notePrefGeneralSubject + `"。

只输出一个 JSON 对象，不要任何其他文字：
{"subject": "学科名", "preferences": {...}, "summary": "一句话偏好描述"}
如果修正指令不包含任何风格偏好（只是内容勘误），输出 {"subject": null, "preferences": {}}`

// notePrefParseLLMText 解析 LLM 响应文本，对应 note-preferences.ts:72-93：
// 从文本中取首个 { 到最后一个 }（/\{[\s\S]*\}/ 贪婪匹配的等价实现），
// preferences 为非空对象才有效；非字符串或空白 subject 回退 fallbackSubject；
// summary 为非空字符串时并入 preferences。无 JSON / 解析失败返回错误
// （调用方回退关键词）。已知差异：TS 对 preferences 为 JSON 数组的失控
// 输出会原样透传，此处按空处理（视为无可提取偏好）。
func notePrefParseLLMText(text string, fallbackSubject string) (notePrefExtraction, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return notePrefExtraction{}, errors.New("LLM response has no JSON object")
	}
	var parsed struct {
		Subject     json.RawMessage `json:"subject"`
		Preferences json.RawMessage `json:"preferences"`
		Summary     json.RawMessage `json:"summary"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &parsed); err != nil {
		return notePrefExtraction{}, err
	}
	prefs := map[string]any{}
	if len(parsed.Preferences) > 0 && parsed.Preferences[0] == '{' {
		_ = json.Unmarshal(parsed.Preferences, &prefs)
	}
	if len(prefs) == 0 {
		// LLM 明确判定无偏好 → 返回 null（不触发关键词回退）
		return notePrefExtraction{}, nil
	}
	var summary string
	if len(parsed.Summary) > 0 && parsed.Summary[0] == '"' {
		_ = json.Unmarshal(parsed.Summary, &summary)
	}
	if summary != "" {
		prefs["summary"] = summary
	}
	subject := fallbackSubject
	var subjectStr string
	if len(parsed.Subject) > 0 && parsed.Subject[0] == '"' {
		_ = json.Unmarshal(parsed.Subject, &subjectStr)
	}
	if trimmed := strings.TrimSpace(subjectStr); trimmed != "" {
		subject = trimmed
	}
	return notePrefExtraction{subject: subject, preferences: prefs, found: true}, nil
}

// notePrefExtract 对应 note-preferences.ts:43-101 的 extractNotePreferences
// （无 subjectHints）：LLM 优先，任何失败（含未配置 API key）回退关键词
// 规则；两条路径都无可提取偏好时 found=false（⇔ TS 返回 null）。
func notePrefExtract(ctx context.Context, refinementPrompt string) notePrefExtraction {
	fallback := func() notePrefExtraction {
		prefs := notePrefExtractByKeywords(refinementPrompt)
		if len(prefs) == 0 {
			return notePrefExtraction{subject: notePrefGeneralSubject}
		}
		return notePrefExtraction{subject: notePrefGeneralSubject, preferences: prefs, found: true}
	}

	cfg := config.Load()
	if cfg.AnthropicAPIKey == "" {
		// TS：anthropic 客户端是 Proxy，缺 key 时调用即抛（ai.ts:36-40）
		// → catch → console.warn + 关键词回退
		log.Printf("[note-preferences] LLM extraction failed, falling back to keywords: " +
			"ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口")
		return fallback()
	}

	text, err := notePrefCallLLM(ctx, cfg, refinementPrompt)
	if err != nil {
		log.Printf("[note-preferences] LLM extraction failed, falling back to keywords: %v", err)
		return fallback()
	}
	res, err := notePrefParseLLMText(text, notePrefGeneralSubject)
	if err != nil {
		log.Printf("[note-preferences] LLM extraction failed, falling back to keywords: %v", err)
		return fallback()
	}
	return res
}

// notePrefCallLLM 调 Anthropic 兼容 messages API（POST {base}/v1/messages）。
// 对齐 TS SDK 配置（ai.ts:27-35）：120s 超时、maxRetries=1（网络错误与
// 408/409/429/5xx 重试一次）。返回拼接后的 text 内容块。
func notePrefCallLLM(ctx context.Context, cfg *config.Config, refinementPrompt string) (string, error) {
	base := strings.TrimRight(cfg.AnthropicBaseURL, "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	payload, err := json.Marshal(map[string]any{
		"model":      cfg.DefaultModel,
		"max_tokens": 8192,
		"system":     notePrefLLMSystemPrompt,
		"messages": []any{map[string]any{
			"role":    "user",
			"content": "修正指令：" + refinementPrompt,
		}},
	})
	if err != nil {
		return "", err
	}

	httpClient := &http.Client{}
	do := func() (*http.Response, error) {
		callCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(callCtx, http.MethodPost,
			base+"/v1/messages", bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("x-api-key", cfg.AnthropicAPIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("Content-Type", "application/json")
		return httpClient.Do(req)
	}

	resp, err := do()
	if err == nil && notePrefRetryableStatus(resp.StatusCode) {
		resp.Body.Close()
		resp, err = do()
	}
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("anthropic messages API HTTP %d: %s",
			resp.StatusCode, notePrefTruncate(string(data), 300))
	}

	var msg struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, c := range msg.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	return sb.String(), nil
}

func notePrefRetryableStatus(code int) bool {
	return code == http.StatusRequestTimeout || code == http.StatusConflict ||
		code == http.StatusTooManyRequests || code >= 500
}

func notePrefTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
