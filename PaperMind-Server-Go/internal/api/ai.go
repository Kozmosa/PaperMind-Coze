package api

// ── AI 组（ai.go）────────────────────────────────────────────────────
// 对等移植 server/src/routes/ai.ts（1828 行）。
// 模型/网关配置（ANTHROPIC_*/NOTE_MODEL）在 internal/config 只读；
// Anthropic 调用走 internal/aiclient（非流式 CreateMessage + 流式 StreamMessage）。
//
// 移植要点：
//   - 10 个端点里 8 个是 SSE 流式。TS 先 res.setHeader 再干活、首次
//     res.write 才真正发出响应头，因此 catch 里用 headersSent 区分
//     「还能回 JSON 错误」与「只能补 data: [DONE]」。Go 侧对等做法：
//     ssePrepare 只写 w.Header() 不调 WriteHeader，首个事件写出时
//     net/http 才提交 200——streamAndWrite 返回的 wrote 即 headersSent。
//   - 每个 res.write 之后立即 Flush（Node 直写 socket 无缓冲，Go 的
//     net/http 有 chunk 缓冲，不 Flush 客户端收不到逐块增量）
//   - 检索依赖 internal/retrieval（Unified().Search + LocatePassage +
//     TagStore().BuildFromDatabase）；偏好提取依赖 internal/noteprefs
//   - DB 错误语义：TS `const { data } = await client...` 对 PostgREST
//     错误静默得到 null（不抛出），网络类错误才会 throw 进 catch →
//     aiRowsOrEmpty 精确复刻这一区分（*db.PostgrestError → 空数据）

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/aiclient"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/noteprefs"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/retrieval"
)

func registerAIRoutes(mux *http.ServeMux) {
	// 统一智能体对话（SSE）。Body: { agent, message, context? }
	// agent ∈ knowledge_builder | note_helper | tutor | reflection_mind（ai.ts:35）
	mux.HandleFunc("POST /api/v1/ai/chat", handleAIChat)

	// Tutor 结构化问答（SSE，含引用与图片支持）（ai.ts:101）
	mux.HandleFunc("POST /api/v1/ai/tutor", handleAITutor)

	// AI 知识构建建议（ai.ts:479）
	mux.HandleFunc("POST /api/v1/ai/knowledge-builder", handleAIKnowledgeBuilder)

	// 标签/分类建议（ai.ts:565）
	mux.HandleFunc("POST /api/v1/ai/suggest", handleAISuggest)

	// 关系建议（ai.ts:645）
	mux.HandleFunc("POST /api/v1/ai/suggest-relations", handleAISuggestRelations)

	// 生成反思报告（ai.ts:1270）
	mux.HandleFunc("POST /api/v1/ai/generate-reflection", handleAIGenerateReflection)

	// 笔记助手（ai.ts:1368）
	mux.HandleFunc("POST /api/v1/ai/note-helper", handleAINoteHelper)

	// 生成学习纪要（ai.ts:1459，NOTE_MODEL 快模型）
	mux.HandleFunc("POST /api/v1/ai/generate-note", handleAIGenerateNote)

	// 修正笔记并沉淀偏好（ai.ts:1649）
	mux.HandleFunc("POST /api/v1/ai/refine-note", handleAIRefineNote)

	// 手动刷新向量索引（ai.ts:1809）
	mux.HandleFunc("POST /api/v1/ai/refresh-index", handleAIRefreshIndex)
}

// latexRules 逐字复刻 ai.ts:22-27：前端用 KaTeX 渲染公式，非法 LaTeX 会显示
// 为红色错误源码（issue #25），在 prompt 层约束输出作为第一道兜底。
const latexRules = `
数学公式输出规范（前端用 KaTeX 渲染，非法公式会显示为乱码源码，必须严格遵守）：
- 行内公式用 $...$，独立成段的公式用 $$...$$，不要使用 \( \) 或 \[ \] 以外的变体
- 公式内部只能包含 ASCII 字符和 LaTeX 命令，禁止出现中文和全角符号；中文说明一律写在公式外面
- 公式内部禁止使用任何 Markdown 语法（如 #、>、**、列表符号）
- 只使用 KaTeX 支持的常见命令，避免嵌套过深或冷门宏；不确定时用简洁的线性写法（如 a/b 而非 \dfrac{a}{b}）`

// ── SSE 基础设施 ─────────────────────────────────────────────────────

// ssePrepare 只设置响应头、不提交状态码（对应 TS 的三个 res.setHeader，
// ai.ts:43-45）。首次 Write 时 net/http 才发送 200，此前出错仍可回退
// JSON 错误——这是复刻 express headersSent 语义的关键。
func ssePrepare(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-store, no-transform, must-revalidate")
	h.Set("Connection", "keep-alive")
}

// sseWrite 写一个 `data: {...}\n\n` 事件并立即 Flush。
func sseWrite(w http.ResponseWriter, payload any) error {
	if err := WriteSSE(w, payload); err != nil {
		return err
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	return nil
}

// sseDone 写结束标记 `data: [DONE]\n\n`（ai.ts:83）并 Flush。
func sseDone(w http.ResponseWriter) {
	WriteSSEDone(w)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// streamAndWrite 建立 Anthropic 流式调用，把每个 text delta 作为一个
// `data: {"content":"..."}\n\n` 事件写出，并累积全文（等价 ai.ts 各路由的
// for await + res.write 循环）。wrote 对应 express 的 res.headersSent：
// false 时出错仍可回退 JSON 错误，true 时只能补 data: [DONE] 收尾。
func streamAndWrite(
	ctx context.Context, w http.ResponseWriter,
	model, system string, messages []aiclient.StreamInputMessage, maxTokens int,
) (wrote bool, fullContent string, err error) {
	err = aiclient.StreamMessage(ctx, aiclient.StreamRequest{
		Model:     model,
		MaxTokens: maxTokens,
		System:    system,
		Messages:  messages,
	}, func(text string) error {
		wrote = true // 写出意图即视为头已发出（对齐 headersSent 翻转时机）
		fullContent += text
		return sseWrite(w, struct {
			Content string `json:"content"`
		}{text})
	})
	return wrote, fullContent, err
}

// ── JS 语义小工具（本组局部版）──────────────────────────────────────

// aiWSRune 判定 JS 的 \s 字符集：在 Go 的 unicode.IsSpace 基础上
// 多 \uFEFF（BOM）、少 \u0085（NEL）。cleanCitationSnippet / aiTrimJS
// / scoreBestPage 的空白判定都依赖该边界。
func aiWSRune(r rune) bool {
	if r == '\uFEFF' {
		return true
	}
	if r == '\u0085' {
		return false
	}
	return unicode.IsSpace(r)
}

// aiTrimJS 等价 String.prototype.trim()（按 JS 空白集剥离首尾）。
func aiTrimJS(s string) string {
	return strings.TrimFunc(s, aiWSRune)
}

// aiWSClass 是 JS \s 的正则字符类内容（不含方括号），供本组各正则拼接
// （Go 的 \s 只有 [\t\n\f\r ]，比 JS 少一票 Unicode 空白）。
const aiWSClass = "\\t\\n\\v\\f\\r \\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}"

// aiCompactJSON 以 JSON.stringify 语义输出紧凑 JSON（无空白），
// 供 prompt 里嵌入 DB 行原文（ai.ts:499/765/1175 等 JSON.stringify 调用点）。
func aiCompactJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return "[]"
	}
	return buf.String()
}

// aiRowsOrEmpty 复刻 TS `const { data } = await client...` 的错误语义：
// supabase-js 对 PostgREST 错误（4xx/5xx 带 error 体）不抛出、data=null；
// 网络类错误才会 reject 进路由 catch。*db.PostgrestError → 空数据，
// 其余错误原样上抛。
func aiRowsOrEmpty(raw json.RawMessage, err error) (json.RawMessage, error) {
	if err != nil {
		var pe *db.PostgrestError
		if errors.As(err, &pe) {
			return nil, nil
		}
		return nil, err
	}
	return raw, nil
}

// aiInVals 把请求体里解码出的 any 数组（数字/字符串混合）转成 .in()
// 需要的字符串列表——JS 数字经模板/URL 序列化成十进制文本。
func aiInVals(vals []any) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		out = append(out, pslStringify(v))
	}
	return out
}

// aiInInts 是 []int 版 aiInVals。
func aiInInts(vals []int) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		out = append(out, strconv.Itoa(v))
	}
	return out
}

// aiAnyToInt 把 JSON 解码值还原成 int：仅接受整数值数字（JS 里 5.5 做
// 对象键/严格相等比较都匹配不上整数 id，Go 侧同样判失配）。
func aiAnyToInt(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		if x == math.Trunc(x) {
			return int(x), true
		}
	case int:
		return x, true
	case json.Number:
		if f, err := x.Float64(); err == nil && f == math.Trunc(f) {
			return int(f), true
		}
	}
	return 0, false
}

// aiMapSlice 取 map 里的数组值（非数组/缺省 → nil）。
func aiMapSlice(m map[string]any, key string) []any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].([]any); ok {
		return v
	}
	return nil
}

// nullJSON 显式序列化为 null 的哨兵：TS 里 `pageNumber: null` 产出
// "pageNumber": null（键存在），与字段缺省（键不存在，JSON.stringify
// 丢弃 undefined）是两种不同形状，RN 客户端按存在性区分——用 any 字段
// + jsonNull{} 区分这两种状态。
type nullJSON struct{}

func (nullJSON) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

var jsonNull = nullJSON{}

// strPtr / intPtr / slicePtr 是便捷取址（slicePtr 供 *[]string 的 tags 用）。
func strPtr(s string) *string { return &s }

func intPtr(i int) *int { return &i }

func slicePtr(s []string) *[]string { return &s }

// ── Citation（ai.ts:185-198 的引用卡片形状）─────────────────────────

// citation 字段的可缺省性与 TS 完全一致：
//   - papercore/snippet/fileName/fileUrl/draftId/label 均为可选键——
//     undefined 不出现在 JSON 里（omitempty）
//   - pageNumber 另有显式 null 态（`r.pageNumber || null`），用 jsonNull 表达
//   - tags 用 *[]string：键缺省（图片/节点引用不设 tags）与 "tags":[]
//     （TS 的 `m.tags || []`）是两种形状；Go 的 omitempty 对空切片一律
//     丢键，无法区分，必须走指针
type citation struct {
	Type       string    `json:"type"`
	SourceID   any       `json:"sourceId"` // number | string
	SourceType string    `json:"sourceType"`
	Title      string    `json:"title"`
	Papercore  any       `json:"papercore,omitempty"`
	Tags       *[]string `json:"tags,omitempty"`
	PageNumber any       `json:"pageNumber,omitempty"` // 缺省 | null | 数字 三态
	Snippet    *string   `json:"snippet,omitempty"`
	FileName   *string   `json:"fileName,omitempty"`
	FileURL    *string   `json:"fileUrl,omitempty"` // 当前无构造点，保留形状
	DraftID    any       `json:"draftId,omitempty"`
	Label      *string   `json:"label,omitempty"`

	drop bool `json:"-"` // mapFileContentsToMaterials 的去重标记（TS 的 _drop）
}

// draftIDInt 返回数字型 draftId（TS 的 truthy 判断：null/undefined/0 均跳过）。
func (c *citation) draftIDInt() int {
	if id, ok := aiAnyToInt(c.DraftID); ok && id != 0 {
		return id
	}
	return 0
}

// searchSource 统一 buildTutorPrompt 产出的 searchResults 元素：来自统一
// 索引（unifiedVectorIndex.search）或 Layer 1 显式 nodeIds 构造的条目
// （ai.ts:837-843）。索引当前只产出 study_note/material，pageNumber/
// fileName/draftId 恒为空——保留字段以对齐 TS 的完整分支。
type searchSource struct {
	SourceType string
	SourceID   any
	Title      any
	Papercore  any
	Tags       []string
	Score      float64 // 统一索引结果的最终分（标签加成后），供 Layer 2 排序
	PageNumber any
	FileName   any
	DraftID    any
}

// fcEntry 是注入 context.fileContents 的文件原文条目（ai.ts:950-956、
// loadFileContents 的 allFileContents 元素），键名与 TS 完全一致。
// DraftID/PageNumber 已归一为 int | jsonNull（等价 TS 的 number | null）。
type fcEntry struct {
	DraftID       any    `json:"draft_id"`
	ExtractedText any    `json:"extracted_text"`
	PageNumber    any    `json:"page_number"`
	FileName      string `json:"file_name"`
}

// ── POST /api/v1/ai/chat（ai.ts:35-93）──────────────────────────────

// handleAIChat 统一智能体对话入口（SSE 流式）。
func handleAIChat(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	agent := pslStringify(body["agent"])
	message := pslStringify(body["message"])
	if !jsTruthy(body["agent"]) || !jsTruthy(body["message"]) {
		Error(w, http.StatusBadRequest, "缺少 agent 或 message 参数")
		return
	}
	contextMap, _ := body["context"].(map[string]any)

	// 头先设置但不提交：prompt 构建若失败（DB 异常等），TS 侧 headersSent
	// 仍为 false → 走 JSON 500 分支（ai.ts:87-89）
	ssePrepare(w)

	cfg := config.Load()
	var systemPrompt string
	var err error
	switch agent {
	case "knowledge_builder":
		systemPrompt, err = buildKnowledgeBuilderPrompt(r.Context())
	case "note_helper":
		systemPrompt, err = buildNoteHelperPrompt(r.Context(), contextMap)
	case "tutor":
		// /chat endpoint only needs the prompt string, no searchResults needed
		var tp tutorPrompt
		tp, err = buildTutorPrompt(r.Context(), contextMap, message, false)
		systemPrompt = tp.systemPrompt
	case "reflection_mind":
		// 测试页/聊天客户端不传 context：注入请求用户，否则数据源全空、
		// 反思报告无内容（profile 页走 /generate-reflection 专用端点不受影响）
		systemPrompt, err = buildReflectionPrompt(r.Context(), auth.UserID(r.Context()), "")
	default:
		systemPrompt = "你是一个智能学习助手，帮助用户解决学习问题。回答简洁专业。"
	}
	if err != nil {
		log.Printf("AI Chat Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	wrote, _, serr := streamAndWrite(r.Context(), w, cfg.DefaultModel, systemPrompt,
		[]aiclient.StreamInputMessage{{Role: "user", Content: message}}, 16384)
	if serr != nil {
		log.Printf("AI Chat Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w) // 流已开始：只能补 [DONE] 收尾（ai.ts:90-91）
		return
	}
	sseDone(w)
}

// ── POST /api/v1/ai/tutor（ai.ts:101-182）───────────────────────────

// handleAITutor Tutor 专用接口：SSE 流式输出正文，结束后补一条含 citations
// 的元数据事件。支持图片：context: { imageBase64, mediaType }。
func handleAITutor(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	message := pslStringify(body["message"])
	if !jsTruthy(body["message"]) {
		Error(w, http.StatusBadRequest, "缺少 message 参数")
		return
	}
	contextMap, _ := body["context"].(map[string]any)

	// TS：context?.imageBase64 || null；mediaType || 'image/jpeg'
	imageBase64 := pslStringify(contextMap["imageBase64"])
	mediaType := "image/jpeg"
	if jsTruthy(contextMap["mediaType"]) {
		mediaType = pslStringify(contextMap["mediaType"])
	}
	hasImage := jsTruthy(contextMap["imageBase64"])

	ssePrepare(w)

	cfg := config.Load()
	tp, err := buildTutorPrompt(r.Context(), contextMap, message, hasImage)
	if err != nil {
		// 头未提交（没有任何 write）→ TS 的 !headersSent → JSON 500
		log.Printf("Tutor Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 构建消息：有图片时用 multipart content blocks，否则纯文本（ai.ts:122-136）
	var messages []aiclient.StreamInputMessage
	if hasImage {
		messages = []aiclient.StreamInputMessage{{
			Role: "user",
			Content: []aiclient.ContentBlock{
				{Type: "image", Source: &aiclient.ImageSource{
					Type:      "base64",
					MediaType: mediaType,
					Data:      imageBase64,
				}},
				{Type: "text", Text: message},
			},
		}}
	} else {
		messages = []aiclient.StreamInputMessage{{Role: "user", Content: message}}
	}

	wrote, fullContent, serr := streamAndWrite(r.Context(), w, cfg.DefaultModel,
		tp.systemPrompt, messages, 16384)
	if serr != nil {
		log.Printf("Tutor Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}

	// 流结束后提取 citations 并发送元数据。把 buildTutorPrompt 收集的节点
	// 关联文件原文注入 context.fileContents，打通架构规格 1.4 优先级 4
	//（此前 allFileContents 从未传到这里，是死路径）
	merged := map[string]any{}
	for k, v := range contextMap {
		merged[k] = v
	}
	merged["message"] = message
	citations := extractCitations(r.Context(), fullContent, merged,
		tp.allFileContents, tp.searchResults)

	if err := sseWrite(w, struct {
		Content   string     `json:"content"`
		Done      bool       `json:"done"`
		Citations []citation `json:"citations"`
	}{"", true, citations}); err != nil {
		log.Printf("Tutor Error: %v", err)
	}
	sseDone(w)
}

// ── prompt 构建 ──────────────────────────────────────────────────────

// nodeBriefRow 对应 ai.ts:493-497 / 753-757 的
// select('id, papercore, tags') 行。
type nodeBriefRow struct {
	ID        int      `json:"id"`
	Papercore *string  `json:"papercore"`
	Tags      []string `json:"tags"`
}

// buildKnowledgeBuilderPrompt 对应 ai.ts:752-769。
func buildKnowledgeBuilderPrompt(ctx context.Context) (string, error) {
	client, err := db.Get()
	if err != nil {
		return "", err
	}
	raw, err := aiRowsOrEmpty(client.From(db.TableKnowledgeNodes).
		Select("id, papercore, tags").
		Order("created_at", false).Limit(50).Rows(ctx))
	if err != nil {
		return "", err
	}
	nodesCtx := "[]" // TS：JSON.stringify(existingNodes || [])
	if len(raw) > 0 {
		nodesCtx = aiCompactJSON(raw)
	}
	return `你是知识构建助手 knowledge_builder，帮助用户构建知识节点。

核心职责：
1. 辅助撰写高质量的知识节点梗概（Papercore）
2. 提取和优化标签

现有知识图谱：` + nodesCtx + `

回答格式：
每个回答包含建议的 Papercore 和 TAGS。回答专业清晰。`, nil
}

// buildNoteHelperPrompt 对应 ai.ts:771-808。
func buildNoteHelperPrompt(ctx context.Context, contextMap map[string]any) (string, error) {
	stylePreference := ""
	if jsTruthy(contextMap["userId"]) {
		userID := pslStringify(contextMap["userId"])
		client, err := db.Get()
		if err != nil {
			return "", err
		}
		raw, err := aiRowsOrEmpty(client.From(db.TablePapernoteStyle).
			Select("*").Eq("user_id", userID).Limit(1).Rows(ctx))
		if err != nil {
			return "", err
		}
		var styles []db.PapernoteStyle
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &styles); err != nil {
				return "", err
			}
		}
		if len(styles) > 0 {
			// FormatSubjectPreferencesForPrompt 内部会 normalize，兼容旧的
			// 平铺结构和新的学科分层结构
			general := "无"
			if styles[0].GeneralPreference != nil && *styles[0].GeneralPreference != "" {
				general = *styles[0].GeneralPreference
			}
			stylePreference = "用户笔记偏好：\n- 总偏好：" + general +
				"\n- 学科偏好：\n" +
				noteprefs.FormatSubjectPreferencesForPrompt(styles[0].SubjectPreferences)
		}
	}

	// 知识节点内容
	nodeContent := ""
	if jsTruthy(contextMap["papercore"]) {
		tags := aiMapSlice(contextMap, "tags")
		prefixed := make([]string, 0, len(tags))
		for _, t := range tags {
			prefixed = append(prefixed, "#"+pslStringify(t))
		}
		nodeContent = "【知识节点核心理解】\n" + pslStringify(contextMap["papercore"]) +
			"\n\n【标签】\n" + strings.Join(prefixed, " ")
	}

	nodeBlock := "【知识节点信息】\n暂无节点内容，请基于一般知识生成标准笔记模板。"
	if nodeContent != "" {
		nodeBlock = nodeContent
	}
	styleBlock := "尚无明确的笔记偏好记录，请用通用高质量笔记格式。"
	if stylePreference != "" {
		styleBlock = stylePreference
	}
	return `你是笔记助手 note_helper，根据知识节点内容和用户笔记偏好生成结构化笔记。

` + nodeBlock + `

` + styleBlock + `

笔记要求：
- 标题层级组织
- 重点用**加粗**
- 列表/表格辅助
- 包含关键概念、原理、示例
- 结尾有简短总结

请直接生成笔记内容，不需要询问用户。`, nil
}

// tutorPrompt 是 buildTutorPrompt 的返回结构（ai.ts:810-814）。
type tutorPrompt struct {
	systemPrompt    string
	searchResults   []searchSource
	allFileContents []fcEntry
}

// tutorNodeRow 对应 ai.ts:823-825 / 871-874 的
// select('id, papercore, tags, short_name, attached_draft_ids') 行。
type tutorNodeRow struct {
	ID               int      `json:"id"`
	Papercore        *string  `json:"papercore"`
	Tags             []string `json:"tags"`
	ShortName        *string  `json:"short_name"`
	AttachedDraftIDs []any    `json:"attached_draft_ids"`
}

// nodeBriefLine 渲染 `[${short_name || '节点'+id}] ${papercore || '(暂无概述)'} 标签:...`
// （ai.ts:830-833、975-977 共用的条目格式）。
func nodeBriefLine(n tutorNodeRow) string {
	short := "节点" + strconv.Itoa(n.ID)
	if n.ShortName != nil && *n.ShortName != "" {
		short = *n.ShortName
	}
	papercore := "(暂无概述)"
	if n.Papercore != nil && *n.Papercore != "" {
		papercore = *n.Papercore
	}
	return "[" + short + "] " + papercore + " 标签:" + strings.Join(tagsOrEmptyStr(n.Tags), ",")
}

// tagsOrEmptyStr 对应 TS 的 `(n.tags || [])` / `|| []` 兜底。
func tagsOrEmptyStr(tags []string) []string {
	if tags != nil {
		return tags
	}
	return []string{}
}

// fetchTutorNodes 拉取 knowledge_nodes 的 tutor 行集（错误语义同 aiRowsOrEmpty）。
func fetchTutorNodes(ctx context.Context, client *db.Client, ids []string) ([]tutorNodeRow, error) {
	q := client.From(db.TableKnowledgeNodes).
		Select("id, papercore, tags, short_name, attached_draft_ids")
	if len(ids) > 0 {
		q = q.In("id", ids)
	}
	raw, err := aiRowsOrEmpty(q.Rows(ctx))
	if err != nil {
		return nil, err
	}
	var rows []tutorNodeRow
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &rows); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// buildTutorPrompt 对应 ai.ts:810-1066：三层上下文装配
// （Layer 1 显式 nodeIds → Layer 2 统一检索 → Layer 3 全量兜底）。
func buildTutorPrompt(
	ctx context.Context, contextMap map[string]any, userMessage string, hasImage bool,
) (tutorPrompt, error) {
	var result tutorPrompt
	knowledgeContext := ""
	fileContentsContext := ""
	result.allFileContents = []fcEntry{}
	result.searchResults = []searchSource{}

	client, err := db.Get()
	if err != nil {
		return result, err
	}

	// ── Layer 1: User-specified knowledge nodes ──────────────────
	if nodeIDs := aiMapSlice(contextMap, "nodeIds"); len(nodeIDs) > 0 {
		nodes, err := fetchTutorNodes(ctx, client, aiInVals(nodeIDs))
		if err != nil {
			return result, err
		}
		if len(nodes) > 0 {
			lines := make([]string, 0, len(nodes))
			for _, n := range nodes {
				lines = append(lines, nodeBriefLine(n))
			}
			knowledgeContext = fmt.Sprintf("【相关知识节点 (%d个)】\n%s", len(nodes), strings.Join(lines, "\n"))

			// Build searchResults-like entries for citations
			for _, n := range nodes {
				title := fmt.Sprintf("节点%d", n.ID)
				if n.ShortName != nil && *n.ShortName != "" {
					title = *n.ShortName
				}
				result.searchResults = append(result.searchResults, searchSource{
					SourceType: "knowledge_node",
					SourceID:   n.ID,
					Title:      title,
					Papercore:  n.Papercore, // 可能是 null → 引用里输出 "papercore": null
					Tags:       tagsOrEmptyStr(n.Tags),
				})
			}

			var allDraftIDs []int
			for _, n := range nodes {
				for _, d := range n.AttachedDraftIDs {
					if id, ok := aiAnyToInt(d); ok {
						allDraftIDs = append(allDraftIDs, id)
					}
				}
			}
			if len(allDraftIDs) > 0 {
				fileContentsContext, result.allFileContents, err = loadFileContents(ctx, client, allDraftIDs)
				if err != nil {
					return result, err
				}
			}
		}
	}

	// ── Layer 2: Unified semantic + tag search ───────────────────
	if knowledgeContext == "" && userMessage != "" {
		results, serr := retrieval.Unified().Search(ctx, userMessage, 10, 0.3)
		if serr != nil {
			// TS 的 search 内部 catch 一切错误并返回 []（unified-vector-index.ts:288-290）
			log.Printf("[UnifiedVectorIndex] Search failed: %v", serr)
			results = nil
		}
		for _, r := range results {
			result.searchResults = append(result.searchResults, searchSource{
				SourceType: string(r.SourceType),
				SourceID:   r.SourceID,
				Title:      r.Title,
				Papercore:  r.Papercore,
				Tags:       r.Tags,
				Score:      r.Score,
			})
		}
		if len(result.searchResults) > 0 {
			var contextLines []string

			var knIDs, snIDs, mIDs []string
			var fcResults []searchSource
			for _, r := range result.searchResults {
				switch r.SourceType {
				case "knowledge_node":
					knIDs = append(knIDs, pslStringify(r.SourceID))
				case "study_note":
					snIDs = append(snIDs, pslStringify(r.SourceID))
				case "material":
					mIDs = append(mIDs, pslStringify(r.SourceID))
				case "file_content":
					fcResults = append(fcResults, r)
				}
			}

			// ── knowledge_nodes ────────────────────────────────
			if len(knIDs) > 0 {
				nodes, err := fetchTutorNodes(ctx, client, knIDs)
				if err != nil {
					return result, err
				}
				if len(nodes) > 0 {
					scoreMap := map[int]float64{}
					for _, r := range result.searchResults {
						if r.SourceType != "knowledge_node" {
							continue
						}
						if id, ok := aiAnyToInt(r.SourceID); ok {
							scoreMap[id] = r.Score
						}
					}
					// TS Array.sort 稳定排序，同分保持原序
					sort.SliceStable(nodes, func(a, b int) bool {
						return scoreMap[nodes[b].ID] > scoreMap[nodes[a].ID]
					})
					nodeLines := make([]string, 0, len(nodes))
					for _, n := range nodes {
						short := "节点" + strconv.Itoa(n.ID)
						if n.ShortName != nil && *n.ShortName != "" {
							short = *n.ShortName
						}
						papercore := ""
						if n.Papercore != nil {
							papercore = *n.Papercore
						}
						nodeLines = append(nodeLines, fmt.Sprintf(
							"[知识节点: %s] %s 标签:%s [相关度: %.2f]",
							short, papercore, strings.Join(tagsOrEmptyStr(n.Tags), ","),
							scoreMap[n.ID]))
					}
					contextLines = append(contextLines, fmt.Sprintf(
						"【知识节点 (%d个)】\n%s", len(nodes), strings.Join(nodeLines, "\n")))

					// Fetch attached file contents
					var allDraftIDs []int
					for _, n := range nodes {
						for _, d := range n.AttachedDraftIDs {
							if id, ok := aiAnyToInt(d); ok {
								allDraftIDs = append(allDraftIDs, id)
							}
						}
					}
					if len(allDraftIDs) > 0 {
						knFcCtx, _, err := loadFileContents(ctx, client, allDraftIDs)
						if err != nil {
							return result, err
						}
						if knFcCtx != "" {
							contextLines = append(contextLines, knFcCtx)
						}
					}
				}
			}

			// ── study_notes ────────────────────────────────────
			if len(snIDs) > 0 {
				raw, err := aiRowsOrEmpty(client.From(db.TableStudyNotes).
					Select("id, papercore, tags, title, content").
					In("id", snIDs).Rows(ctx))
				if err != nil {
					return result, err
				}
				var notes []struct {
					ID        int      `json:"id"`
					Papercore *string  `json:"papercore"`
					Tags      []string `json:"tags"`
					Title     *string  `json:"title"`
					Content   *string  `json:"content"`
				}
				if len(raw) > 0 {
					if err := json.Unmarshal(raw, &notes); err != nil {
						return result, err
					}
				}
				if len(notes) > 0 {
					noteLines := make([]string, 0, len(notes))
					for _, n := range notes {
						title := "纪要" + strconv.Itoa(n.ID)
						if n.Title != nil && *n.Title != "" {
							title = *n.Title
						}
						papercore := ""
						if n.Papercore != nil {
							papercore = *n.Papercore
						}
						content := ""
						if n.Content != nil {
							content = *n.Content
						}
						noteLines = append(noteLines, fmt.Sprintf(
							"[学习纪要: %s] %s 标签:%s\n内容摘要: %s",
							title, papercore, strings.Join(tagsOrEmptyStr(n.Tags), ","),
							pslTruncateRunes(content, 200)))
					}
					contextLines = append(contextLines, fmt.Sprintf(
						"\n【学习纪要 (%d个)】\n%s", len(notes), strings.Join(noteLines, "\n---\n")))
				}
			}

			// ── materials ──────────────────────────────────────
			if len(mIDs) > 0 {
				raw, err := aiRowsOrEmpty(client.From(db.TableMaterials).
					Select("id, papercore, tags, name, file_path").
					In("id", mIDs).Rows(ctx))
				if err != nil {
					return result, err
				}
				var materials []struct {
					ID        int      `json:"id"`
					Papercore *string  `json:"papercore"`
					Tags      []string `json:"tags"`
					Name      *string  `json:"name"`
				}
				if len(raw) > 0 {
					if err := json.Unmarshal(raw, &materials); err != nil {
						return result, err
					}
				}
				if len(materials) > 0 {
					matLines := make([]string, 0, len(materials))
					for _, m := range materials {
						name := "资料" + strconv.Itoa(m.ID)
						if m.Name != nil && *m.Name != "" {
							name = *m.Name
						}
						papercore := ""
						if m.Papercore != nil {
							papercore = *m.Papercore
						}
						matLines = append(matLines, fmt.Sprintf("[资料: %s] %s 标签:%s",
							name, papercore, strings.Join(tagsOrEmptyStr(m.Tags), ",")))
					}
					contextLines = append(contextLines, fmt.Sprintf(
						"\n【学习资料 (%d个)】\n%s", len(materials), strings.Join(matLines, "\n")))
				}
			}

			// ── file_contents ──────────────────────────────────
			if len(fcResults) > 0 {
				fcLines := make([]string, 0, len(fcResults))
				for _, r := range fcResults {
					pageInfo := ""
					if jsTruthy(r.PageNumber) {
						pageInfo = fmt.Sprintf("第%s页", pslStringify(r.PageNumber))
					}
					fName := "文件"
					if jsTruthy(r.FileName) {
						fName = pslStringify(r.FileName)
					}
					fcLines = append(fcLines, fmt.Sprintf("[原文片段: %s %s] %s",
						fName, pageInfo, pslTruncateRunes(pslStringify(r.Papercore), 300)))
				}
				contextLines = append(contextLines, fmt.Sprintf(
					"\n【原文片段 (%d个)】\n%s", len(fcResults), strings.Join(fcLines, "\n---\n")))
			}

			knowledgeContext = strings.Join(contextLines, "\n")

			// Collect file_contents for citation metadata
			for _, r := range fcResults {
				result.allFileContents = append(result.allFileContents, fcEntry{
					DraftID:       r.DraftID,
					ExtractedText: r.Papercore,
					PageNumber:    r.PageNumber,
					FileName:      pslStringify(r.FileName),
				})
			}
		}
	}

	// ── Layer 3: Fallback — load all recent from three tables ──
	if knowledgeContext == "" {
		var contextLines []string

		// knowledge_nodes
		raw, err := aiRowsOrEmpty(client.From(db.TableKnowledgeNodes).
			Select("id, papercore, tags, short_name").
			Order("created_at", false).Limit(100).Rows(ctx))
		if err != nil {
			return result, err
		}
		var knRows []tutorNodeRow
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &knRows); err != nil {
				return result, err
			}
		}
		if len(knRows) > 0 {
			lines := make([]string, 0, len(knRows))
			for _, n := range knRows {
				lines = append(lines, nodeBriefLine(n))
			}
			contextLines = append(contextLines, fmt.Sprintf(
				"【知识库节点 (%d个)】\n%s", len(knRows), strings.Join(lines, "\n")))
			// Layer 3 降级结果仅作 Prompt 上下文，不进 searchResults：
			// 否则无匹配提问会渲染上百张引用卡片淹没正文（issue #5 Task 6）
		}

		// study_notes
		raw, err = aiRowsOrEmpty(client.From(db.TableStudyNotes).
			Select("id, papercore, tags, title").
			Eq("ai_processed", "true").
			Order("created_at", false).Limit(50).Rows(ctx))
		if err != nil {
			return result, err
		}
		var snRows []struct {
			ID        int      `json:"id"`
			Papercore *string  `json:"papercore"`
			Tags      []string `json:"tags"`
			Title     *string  `json:"title"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &snRows); err != nil {
				return result, err
			}
		}
		if len(snRows) > 0 {
			lines := make([]string, 0, len(snRows))
			for _, n := range snRows {
				title := "纪要" + strconv.Itoa(n.ID)
				if n.Title != nil && *n.Title != "" {
					title = *n.Title
				}
				papercore := ""
				if n.Papercore != nil {
					papercore = *n.Papercore
				}
				lines = append(lines, fmt.Sprintf("[学习纪要: %s] %s 标签:%s",
					title, papercore, strings.Join(tagsOrEmptyStr(n.Tags), ",")))
			}
			contextLines = append(contextLines, fmt.Sprintf(
				"\n【学习纪要 (%d个)】\n%s", len(snRows), strings.Join(lines, "\n")))
		}

		// materials
		raw, err = aiRowsOrEmpty(client.From(db.TableMaterials).
			Select("id, papercore, tags, name").
			Eq("ai_processed", "true").
			Order("created_at", false).Limit(50).Rows(ctx))
		if err != nil {
			return result, err
		}
		var mRows []struct {
			ID        int      `json:"id"`
			Papercore *string  `json:"papercore"`
			Tags      []string `json:"tags"`
			Name      *string  `json:"name"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &mRows); err != nil {
				return result, err
			}
		}
		if len(mRows) > 0 {
			lines := make([]string, 0, len(mRows))
			for _, m := range mRows {
				name := "资料" + strconv.Itoa(m.ID)
				if m.Name != nil && *m.Name != "" {
					name = *m.Name
				}
				papercore := ""
				if m.Papercore != nil {
					papercore = *m.Papercore
				}
				lines = append(lines, fmt.Sprintf("[资料: %s] %s 标签:%s",
					name, papercore, strings.Join(tagsOrEmptyStr(m.Tags), ",")))
			}
			contextLines = append(contextLines, fmt.Sprintf(
				"\n【学习资料 (%d个)】\n%s", len(mRows), strings.Join(lines, "\n")))
		}

		knowledgeContext = strings.Join(contextLines, "\n")
	}

	// ── Image analysis instructions ──────────────────────────────
	imageInstruction := ""
	if hasImage {
		imageInstruction = `
🖼️ 用户上传了一张图片。请仔细分析图片中的内容（文字、公式、图表等）。在回答时：
- 先描述你在图片中看到的内容（公式、推导步骤等）
- 用自然语言标注关键区域，格式：【区域：{位置描述}】（例如"【区域：图片左上角的公式】"、"【区域：第2步到第3步的推导过程】"）
- 将图片内容与知识库中的相关节点关联起来
- 如果图片是手写笔记，尝试识别其中的文字和公式
`
	}

	if knowledgeContext == "" {
		// TS 模板两分支在 ${imageInstruction} 后各有一个模板换行
		//（ai.ts:899-917），无图（空串）时体现为「。\n\n知识库」——Go 侧
		// 必须显式补 "\n"，否则少一个换行（prompt 对拍实测差 2 字节）。
		result.systemPrompt = `你是智能导师 tutor。
` + imageInstruction + `
知识库中尚未找到与该问题直接相关的内容。

⚠️ 请先告知用户"知识库中没有相应内容"，然后用你的常识给出解答，最后询问用户是否需要将解答补充进知识库。

回答要求：条理清晰、有具体示例、可给出后续学习方向。
` + latexRules
		return result, nil
	}

	result.systemPrompt = `你是智能导师 tutor，基于以下知识库内容回答用户的问题。
` + imageInstruction + `
` + knowledgeContext + fileContentsContext + `

⚠️ 重要要求：
1. 回答必须简洁有条理，不要重复相同内容
2. 如果问题涉及知识库中的内容，引用对应来源名称给出详细解答
3. 如果问题不在知识库范围内，用你的常识回答，并询问用户是否需要将解答补充进知识库
4. 提供具体示例
5. 【强制】回答中每实际使用一个知识库来源（资料/纪要），必须紧跟标注【来源：{名称}】；
   标注的名称必须与提供的来源名称完全一致，不要用简称；没有实际使用的来源不要标注
6. PDF/文件来源请明确引用页码，格式：【来源：{文件名}，第N页】
7. 如需高亮关键原文位置，用「原文...」包裹引用内容
8. 给出后续学习建议
9. 回答完后，在消息末尾添加引用来源汇总，格式：「引用来源：来源名称1、来源名称2」
` + latexRules
	return result, nil
}

// loadFileContents 对应 ai.ts:1071-1109：取一批 draft_id 的
// file_contents + draft_pool 元数据，产出 prompt 片段与引用元数据。
func loadFileContents(ctx context.Context, client *db.Client, draftIDs []int) (string, []fcEntry, error) {
	sliced := draftIDs
	if len(sliced) > 20 {
		sliced = sliced[:20]
	}
	raw, err := aiRowsOrEmpty(client.From(db.TableFileContents).
		Select("draft_id, extracted_text, page_number").
		In("draft_id", aiInInts(sliced)).Rows(ctx))
	if err != nil {
		return "", nil, err
	}
	var fileRows []struct {
		DraftID       *int    `json:"draft_id"`
		ExtractedText *string `json:"extracted_text"`
		PageNumber    *int    `json:"page_number"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &fileRows); err != nil {
			return "", nil, err
		}
	}
	if len(fileRows) == 0 {
		return "", []fcEntry{}, nil
	}

	rawDrafts, err := aiRowsOrEmpty(client.From(db.TableDraftPool).
		Select("id, file_name, file_url").
		In("id", aiInInts(sliced)).Rows(ctx))
	if err != nil {
		return "", nil, err
	}
	var drafts []struct {
		ID       int     `json:"id"`
		FileName *string `json:"file_name"`
		FileURL  *string `json:"file_url"`
	}
	if len(rawDrafts) > 0 {
		if err := json.Unmarshal(rawDrafts, &drafts); err != nil {
			return "", nil, err
		}
	}
	draftName := map[int]string{}
	for _, d := range drafts {
		if d.FileName != nil {
			draftName[d.ID] = *d.FileName
		}
	}

	fileDetails := make([]string, 0, len(fileRows))
	entries := make([]fcEntry, 0, len(fileRows))
	for _, fc := range fileRows {
		fileName := draftName[derefInt(fc.DraftID)]
		pageInfo := ""
		if fc.PageNumber != nil && *fc.PageNumber != 0 {
			pageInfo = fmt.Sprintf("[第%d页] ", *fc.PageNumber)
		}
		text := ""
		if fc.ExtractedText != nil {
			text = *fc.ExtractedText
		}
		// 归一为 int | jsonNull，等价 TS 的 number | null（draft_id 可空）
		did := any(jsonNull)
		if fc.DraftID != nil {
			did = *fc.DraftID
		}
		pn := any(jsonNull)
		if fc.PageNumber != nil {
			pn = *fc.PageNumber
		}
		fileDetails = append(fileDetails, fmt.Sprintf("%s「%s」: %s",
			pageInfo, fileNameOr(fileName, "未知文件"), pslTruncateRunes(text, 300)))
		entries = append(entries, fcEntry{
			DraftID:       did,
			ExtractedText: text,
			PageNumber:    pn,
			FileName:      fileName,
		})
	}
	return "\n\n相关文件内容：\n" + strings.Join(fileDetails, "\n---\n"), entries, nil
}

// fileNameOr 对应 TS 的 `file_name || '未知文件'`（空串同样回退）。
func fileNameOr(name, fallback string) string {
	if name != "" {
		return name
	}
	return fallback
}

// derefInt 解引用 *int（nil → 0）。
func derefInt(p *int) int {
	if p != nil {
		return *p
	}
	return 0
}

// ── citations 提取（ai.ts:200-471）──────────────────────────────────

// snippetPaginationRe 对应 ai.ts:205 的 /--\s*\d+\s*of\s*\d+\s*--/gi
// （历史数据残留的分页占位符，如 "-- 1 of 67 --"）。
var snippetPaginationRe = regexp.MustCompile(`(?i)--[` + aiWSClass + `]*\d+[` + aiWSClass + `]*of[` + aiWSClass + `]*\d+[` + aiWSClass + `]*--`)

// snippetEllipsisRe 对应 ai.ts:206 的 /\.{3,}|…+/g。
var snippetEllipsisRe = regexp.MustCompile(`\.{3,}|…+`)

// snippetWhitespaceRe 对应 ai.ts:207 的 /\s+/g（JS \s 字符集）。
var snippetWhitespaceRe = regexp.MustCompile(`[` + aiWSClass + `]+`)

// mentionRe 对应 ai.ts:443 的 /【来源[:：]\s*([^】\n]+)】/g。
var mentionRe = regexp.MustCompile(`【来源[:：][` + aiWSClass + `]*([^】\n]+)】`)

// cleanCitationSnippet 对应 ai.ts:202-210：去掉分页占位符、省略号，压缩空白；
// 清洗后为空返回 nil（TS 返回 undefined → JSON 键缺省）。
func cleanCitationSnippet(text *string) *string {
	if text == nil || *text == "" {
		return nil
	}
	cleaned := snippetPaginationRe.ReplaceAllString(*text, "")
	cleaned = snippetEllipsisRe.ReplaceAllString(cleaned, "")
	cleaned = snippetWhitespaceRe.ReplaceAllString(cleaned, " ")
	cleaned = aiTrimJS(cleaned)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

// extractCitations 对应 ai.ts:269-471。contextMap 即 TS 的 context
// （/tutor 已合并 message），fileContents 是显式传入的 context.fileContents
// （buildTutorPrompt 的 allFileContents）。TS 内部各查询失败均静默降级
// （catch + console.warn），此处同——函数不返回 error。
func extractCitations(
	ctx context.Context, answer string,
	contextMap map[string]any, fileContents []fcEntry, searchResults []searchSource,
) []citation {
	citations := []citation{}

	// 用户上传的图片引用
	if jsTruthy(contextMap["imageBase64"]) {
		imageFileName := pslStringify(jsOr(contextMap["imageFileName"], "uploaded_image"))
		title := pslStringify(jsOr(contextMap["imageFileName"], "上传的图片"))
		citations = append(citations, citation{
			Type:       "image",
			SourceID:   imageFileName,
			SourceType: "image",
			Title:      title,
			FileName:   strPtr(title),
			Label:      strPtr("用户上传的图片"),
			Snippet:    strPtr("图片已由 AI 视觉分析处理"),
		})
	}

	// ── From search results (unified vector index) ───────────────
	for _, r := range searchResults {
		var snippet *string
		if r.SourceType == "file_content" {
			// already snipped in index
			snippet = cleanCitationSnippet(strPtr(pslStringify(r.Papercore)))
		} else if s, ok := r.Papercore.(string); ok {
			snippet = cleanCitationSnippet(strPtr(pslTruncateRunes(s, 200)))
		}
		var fileName *string
		if jsTruthy(r.FileName) {
			fileName = strPtr(pslStringify(r.FileName))
		}
		citations = append(citations, citation{
			Type:       r.SourceType,
			SourceID:   r.SourceID,
			SourceType: r.SourceType,
			Title:      pslStringify(r.Title),
			Papercore:  r.Papercore,
			Tags:       slicePtr(tagsOrEmptyStr(r.Tags)),
			PageNumber: jsOr(r.PageNumber, jsonNull), // TS：r.pageNumber || null
			Snippet:    snippet,
			FileName:   fileName,
			DraftID:    r.DraftID,
		})
	}

	// Stage 2 文段定位：对命中的资料全文做文段级检索（\f 分页 + 500 字分块，
	// 惰性嵌入缓存），返回精确页码 + 相关文段文字；MD 等单页文件同样受益
	if message := pslStringify(contextMap["message"]); message != "" &&
		anyMaterialWithSourceID(citations) {
		if client, err := db.Get(); err != nil {
			log.Printf("[extractCitations] 文段定位失败: %v", err)
		} else if raw, qerr := aiRowsOrEmpty(client.From(db.TableMaterials).
			Select("id, extracted_text, name, file_type").
			In("id", aiInInts(materialSourceIDs(citations))).Limit(50).Rows(ctx)); qerr != nil {
			log.Printf("[extractCitations] 文段定位失败: %v", qerr)
		} else {
			var mats []struct {
				ID            int     `json:"id"`
				ExtractedText *string `json:"extracted_text"`
				Name          *string `json:"name"`
				FileType      *string `json:"file_type"`
			}
			if len(raw) > 0 {
				_ = json.Unmarshal(raw, &mats)
			}
			matText := map[int]string{}
			for _, m := range mats {
				if m.ExtractedText != nil {
					matText[m.ID] = *m.ExtractedText
				}
			}
			q := pslTruncateRunes(message, 500)
			// 并行定位（用户方案：被命中文件的原文并行检索）
			var wg sync.WaitGroup
			for _, ci := range materialCitIndexes(citations) {
				extracted, ok := matText[sourceIDInt(citations[ci].SourceID)]
				if !ok || extracted == "" {
					continue
				}
				// MD/TXT 没有页码概念：与纪要一致只返回相应文字，不携带 pageNumber。
				// 数据驱动判断：提取文本含 \f 分页符 = 有多页概念（PPT/PDF/扫描件）；
				// 种子数据 file_type 可能错标 text/plain，不可依赖
				hasPages := strings.Contains(extracted, "\f")
				mid := sourceIDInt(citations[ci].SourceID)
				wg.Add(1)
				go func(c *citation) {
					defer wg.Done()
					hit, _ := retrieval.LocatePassage(ctx, strconv.Itoa(mid), extracted, q)
					if hit != nil {
						// 保留换行原样：弹窗按 markdown 渲染需要段落结构；
						// cleanCitationSnippet 会把 \n 压成空格，整段塌成一个巨型 h1
						c.PageNumber = jsonNull
						if hasPages {
							c.PageNumber = hit.PageNumber
						}
						c.Snippet = strPtr(pslTruncateRunes(hit.Text, 300))
					}
				}(&citations[ci])
			}
			wg.Wait()
		}
	}

	// ── Explicitly selected nodes ────────────────────────────────
	if nodeIDs := aiMapSlice(contextMap, "nodeIds"); len(nodeIDs) > 0 {
		existing := map[string]bool{}
		for i := range citations {
			if citations[i].Type == "knowledge_node" {
				existing[pslStringify(citations[i].SourceID)] = true
			}
		}
		for _, nodeID := range nodeIDs {
			key := pslStringify(nodeID)
			if !existing[key] {
				title := "知识节点 " + key
				citations = append(citations, citation{
					Type:       "knowledge_node",
					SourceID:   nodeID,
					SourceType: "knowledge_node",
					Title:      title,
					Label:      strPtr(title),
				})
			}
		}
	}

	// ── Fallback: explicit file contents from context ────────────
	if len(fileContents) > 0 {
		existingFcIDs := map[int]bool{}
		for i := range citations {
			// TS 按现有 file_content 引用的 sourceId 去重（ai.ts:369-373），
			// 再用 fc.draft_id 比对——两条 id 在可达路径上同值
			if citations[i].Type == "file_content" {
				if id := sourceIDInt(citations[i].SourceID); id != 0 {
					existingFcIDs[id] = true
				}
			}
		}
		for _, fc := range fileContents {
			id := 0
			if v, ok := aiAnyToInt(fc.DraftID); ok {
				id = v
			}
			if id != 0 && existingFcIDs[id] {
				continue
			}
			var snippet *string
			if s, ok := fc.ExtractedText.(string); ok {
				snippet = cleanCitationSnippet(strPtr(pslTruncateRunes(s, 200)))
			}
			title := "文件片段"
			if fc.FileName != "" {
				title = fc.FileName
			}
			fileName := "未知文件"
			if fc.FileName != "" {
				fileName = fc.FileName
			}
			citations = append(citations, citation{
				Type:       "file_content",
				SourceID:   fc.DraftID,
				SourceType: "file_content",
				Title:      title,
				FileName:   strPtr(fileName),
				PageNumber: fc.PageNumber, // 已归一为 int | jsonNull（TS 直传）
				Snippet:    snippet,
				DraftID:    fc.DraftID,
			})
		}
	}

	// ── User-uploaded file (context.draftId) ─────────────────────
	if draftIDVal, ok := aiAnyToInt(jsOr(contextMap["draftId"], nil)); ok && draftIDVal != 0 {
		hasDraft := false
		for i := range citations {
			if (citations[i].Type == "file_content" || citations[i].Type == "material") &&
				citations[i].draftIDInt() == draftIDVal {
				hasDraft = true
				break
			}
		}
		if !hasDraft {
			appendDraftCitation(ctx, &citations, draftIDVal)
		}
	}

	mapFileContentsToMaterials(ctx, &citations)

	// 引用收敛到「回答真正用到的来源」：prompt 要求 AI 用 【来源：XXX】 标注，
	// 解析标记并只保留被提及的来源（否则 top-10 全量返回，混入大量无关引用卡）。
	// 无标记时兜底取前 5 条（按检索分数序）。
	mentions := extractMentions(answer)
	if len(mentions) > 0 {
		if out := filterCitationsByMentions(mentions, citations); out != nil {
			return out
		}
	}

	// 无【来源】标记：回答未实际使用知识库来源 → 不返回引用卡
	//（兜底 top-N 会重新引入噪声：一阶极点留数算法问题曾混入数值积分/绪论）
	out := []citation{}
	for _, c := range citations {
		if c.Type == "image" {
			out = append(out, c)
		}
	}
	return out
}

// appendDraftCitation 对应 ai.ts:394-435：draft_pool 单查 + file_contents
// 首页片段联查。TS 整块 try/catch 静默忽略一切异常，此处同。
func appendDraftCitation(ctx context.Context, citations *[]citation, draftID int) {
	client, err := db.Get()
	if err != nil {
		return
	}
	raw, err := client.From(db.TableDraftPool).
		Select("id, file_name, file_url").Eq("id", strconv.Itoa(draftID)).Single().Rows(ctx)
	if err != nil {
		return // 含 0 行（PGRST116）：draft 为 null → 不追加（TS 同）
	}
	var draft struct {
		ID       int     `json:"id"`
		FileName *string `json:"file_name"`
		FileURL  *string `json:"file_url"`
	}
	if err := json.Unmarshal(raw, &draft); err != nil {
		return
	}

	// 联查 file_contents 取原文片段与页码（issue #5 Task 8），
	// 引用卡片不再只显示「用户当前上传的参考文件」
	snippet := "用户当前上传的参考文件"
	pageNumber := any(jsonNull)
	// TS：order('page_number', { ascending: true, nullsFirst: true }).limit(1)。
	// db 查询构建器不支持 nullsFirst（共享包，本组无权扩展），改为取回该
	// draft 全部行后在内存按「null 在前 + 页码升序」排序取第一条，结果等价
	if fcRaw, fcErr := aiRowsOrEmpty(client.From(db.TableFileContents).
		Select("extracted_text, page_number").
		Eq("draft_id", strconv.Itoa(draft.ID)).Rows(ctx)); fcErr == nil {
		var rows []struct {
			ExtractedText *string `json:"extracted_text"`
			PageNumber    *int    `json:"page_number"`
		}
		if len(fcRaw) > 0 {
			_ = json.Unmarshal(fcRaw, &rows)
		}
		if len(rows) > 0 {
			sort.SliceStable(rows, func(a, b int) bool {
				pa, pb := rows[a].PageNumber, rows[b].PageNumber
				if pa == nil && pb != nil {
					return true
				}
				if pb == nil && pa != nil {
					return false
				}
				if pa != nil && pb != nil {
					return *pa < *pb
				}
				return false
			})
			first := rows[0]
			text := snippet
			if first.ExtractedText != nil && *first.ExtractedText != "" {
				text = *first.ExtractedText
			}
			snippet = pslTruncateRunes(text, 200)
			if first.PageNumber != nil {
				pageNumber = *first.PageNumber
			} else {
				pageNumber = 1 // TS：fcs[0].page_number ?? 1
			}
		}
	}

	name := "上传文件"
	if draft.FileName != nil && *draft.FileName != "" {
		name = *draft.FileName
	}
	*citations = append(*citations, citation{
		Type:       "file_content",
		SourceID:   draft.ID,
		SourceType: "file_content",
		Title:      name,
		FileName:   strPtr(name),
		Snippet:    cleanCitationSnippet(strPtr(snippet)),
		PageNumber: pageNumber,
		DraftID:    draft.ID,
	})
}

// mapFileContentsToMaterials 对应 ai.ts:217-267：file_content 命中映射回源
// 材料。检索可用分页原文辅助命中（检索模式不变），但引用只返回原材料——
// MD/DOCX 显示相应文字（snippet=该页文本），PPT/PDF/扫描件显示对应页
// （pageNumber 保留）；无源材料可映射时保留 file_content。
// TS 整个函数 try/catch：任何异常仅 console.warn 后放弃映射。
func mapFileContentsToMaterials(ctx context.Context, citations *[]citation) {
	hasFC := false
	for i := range *citations {
		if (*citations)[i].Type == "file_content" {
			hasFC = true
			break
		}
	}
	if !hasFC {
		return
	}
	client, err := db.Get()
	if err != nil {
		log.Printf("[extractCitations] file_content 映射回源材料失败: %v", err)
		return
	}

	var fcDraftIDs []int
	for i := range *citations {
		if c := &(*citations)[i]; c.Type == "file_content" && c.draftIDInt() != 0 {
			fcDraftIDs = append(fcDraftIDs, c.draftIDInt())
		}
	}
	draftsRaw, derr := aiRowsOrEmpty(client.From(db.TableDraftPool).
		Select("id, file_url").In("id", aiInInts(fcDraftIDs)).Rows(ctx))
	if derr != nil {
		log.Printf("[extractCitations] file_content 映射回源材料失败: %v", derr)
		return
	}
	var drafts []struct {
		ID      int     `json:"id"`
		FileURL *string `json:"file_url"`
	}
	if len(draftsRaw) > 0 {
		_ = json.Unmarshal(draftsRaw, &drafts)
	}

	var urls []string
	for _, d := range drafts {
		if d.FileURL != nil && *d.FileURL != "" {
			urls = append(urls, *d.FileURL)
		}
	}
	var mats []struct {
		ID            int      `json:"id"`
		Name          *string  `json:"name"`
		Papercore     *string  `json:"papercore"`
		Tags          []string `json:"tags"`
		FilePath      *string  `json:"file_path"`
		FileType      *string  `json:"file_type"`
		ExtractedText *string  `json:"extracted_text"`
	}
	if len(urls) > 0 {
		matsRaw, merr := aiRowsOrEmpty(client.From(db.TableMaterials).
			Select("id, name, papercore, tags, file_path, file_type, extracted_text").
			In("file_path", urls).Limit(50).Rows(ctx))
		if merr != nil {
			log.Printf("[extractCitations] file_content 映射回源材料失败: %v", merr)
			return
		}
		if len(matsRaw) > 0 {
			_ = json.Unmarshal(matsRaw, &mats)
		}
	}
	urlToMat := map[string]int{}
	for i, m := range mats {
		if m.FilePath != nil {
			urlToMat[*m.FilePath] = i
		}
	}
	seenMaterials := map[int]bool{}
	for i := range *citations {
		if (*citations)[i].Type == "material" {
			if id, ok := aiAnyToInt((*citations)[i].SourceID); ok {
				seenMaterials[id] = true
			}
		}
	}
	for i := range *citations {
		c := &(*citations)[i]
		if c.Type != "file_content" || c.draftIDInt() == 0 {
			continue
		}
		var fileURL string
		found := false
		for _, d := range drafts {
			if d.ID == c.draftIDInt() {
				if d.FileURL != nil {
					fileURL = *d.FileURL
				}
				found = true
				break
			}
		}
		if !found {
			continue
		}
		mi, ok := urlToMat[fileURL]
		if !ok {
			continue
		}
		m := mats[mi]
		if seenMaterials[m.ID] {
			c.drop = true
			continue
		}
		c.Type = "material"
		c.SourceID = m.ID
		if m.Name != nil && *m.Name != "" {
			c.Title = *m.Name
		}
		c.Papercore = ""
		if m.Papercore != nil {
			c.Papercore = *m.Papercore
		}
		c.Tags = slicePtr(tagsOrEmptyStr(m.Tags))
		// MD/TXT 无页码概念：映射后清掉 pageNumber（与纪要一致只给文字）。
		// 数据驱动判断：提取文本含 \f 分页符 = 有多页概念（PPT/PDF/扫描件）；
		// 种子数据 file_type 可能错标 text/plain，不可依赖
		extracted := ""
		if m.ExtractedText != nil {
			extracted = *m.ExtractedText
		}
		if !strings.Contains(extracted, "\f") {
			c.PageNumber = jsonNull
		}
		seenMaterials[m.ID] = true
	}
	// 剔除 _drop 项（ai.ts:261-263 的倒序 splice）
	out := (*citations)[:0]
	for i := range *citations {
		if !(*citations)[i].drop {
			out = append(out, (*citations)[i])
		}
	}
	*citations = out
}

// extractMentions 对应 ai.ts:443：解析回答里的 【来源：XXX】 标注。
func extractMentions(answer string) []string {
	var mentions []string
	for _, m := range mentionRe.FindAllStringSubmatch(answer, -1) {
		mentions = append(mentions, aiTrimJS(m[1]))
	}
	return mentions
}

// filterCitationsByMentions 对应 ai.ts:444-465：图片引用保留在首部，
// 其余按「名称互相包含」匹配 mentions，按 type_sourceId 去重；
// 无任何匹配返回 nil（调用方回退 image-only 分支）。
func filterCitationsByMentions(mentions []string, citations []citation) []citation {
	var images, matched []citation
	compactMentions := make([]string, 0, len(mentions))
	for _, m := range mentions {
		compactMentions = append(compactMentions, snippetWhitespaceRe.ReplaceAllString(m, ""))
	}
	for _, c := range citations {
		if c.Type == "image" {
			images = append(images, c)
			continue
		}
		name := c.Title
		if name == "" && c.FileName != nil {
			name = *c.FileName
		}
		nameKey := snippetWhitespaceRe.ReplaceAllString(name, "")
		for _, m2 := range compactMentions {
			// TS：name.includes(m2) || m2.includes(name)
			if strings.Contains(nameKey, m2) || strings.Contains(m2, nameKey) {
				matched = append(matched, c)
				break
			}
		}
	}
	if len(matched) == 0 {
		return nil
	}
	deduped := append(append([]citation{}, images...), matched...)
	seen := map[string]bool{}
	out := make([]citation, 0, len(deduped))
	for _, c := range deduped {
		key := fmt.Sprintf("%v_%v", c.Type, c.SourceID)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, c)
	}
	return out
}

// anyMaterialWithSourceID / materialCitIndexes / materialSourceIDs /
// sourceIDInt 是 Stage 2 的辅助查询函数。
func anyMaterialWithSourceID(citations []citation) bool {
	for i := range citations {
		if citations[i].Type == "material" {
			if _, ok := aiAnyToInt(citations[i].SourceID); ok {
				return true
			}
		}
	}
	return false
}

func materialCitIndexes(citations []citation) []int {
	var out []int
	for i := range citations {
		if citations[i].Type == "material" {
			if _, ok := aiAnyToInt(citations[i].SourceID); ok {
				out = append(out, i)
			}
		}
	}
	return out
}

func materialSourceIDs(citations []citation) []int {
	out := make([]int, 0, len(citations))
	for i := range citations {
		if citations[i].Type == "material" {
			if id, ok := aiAnyToInt(citations[i].SourceID); ok {
				out = append(out, id)
			}
		}
	}
	return out
}

func sourceIDInt(v any) int {
	id, _ := aiAnyToInt(v)
	return id
}

// ── POST /api/v1/ai/knowledge-builder（ai.ts:479-558）───────────────

// handleAIKnowledgeBuilder 辅助构建知识节点（一次性输出 Papercore/Tags），
// 支持图片输入（截图/手写笔记 → 提取概念生成 Papercore + Tags）。
func handleAIKnowledgeBuilder(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	rawContent := pslStringify(body["rawContent"])
	imageBase64 := pslStringify(body["imageBase64"])
	mediaType := "image/jpeg"
	if jsTruthy(body["mediaType"]) {
		mediaType = pslStringify(body["mediaType"])
	}
	hasImage := jsTruthy(body["imageBase64"])

	if !jsTruthy(body["rawContent"]) && !hasImage {
		Error(w, http.StatusBadRequest, "缺少内容（rawContent 或 imageBase64）")
		return
	}

	ssePrepare(w)

	// 获取现有知识图谱节点列表
	client, err := db.Get()
	if err != nil {
		log.Printf("Knowledge Builder Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	nodesRaw, err := aiRowsOrEmpty(client.From(db.TableKnowledgeNodes).
		Select("id, papercore, tags").
		Order("created_at", false).Limit(50).Rows(r.Context()))
	if err != nil {
		log.Printf("Knowledge Builder Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	nodesCtx := "[]"
	if len(nodesRaw) > 0 {
		nodesCtx = aiCompactJSON(nodesRaw)
	}

	imageSegment := ""
	if hasImage {
		imageSegment = "\n🖼️ 用户上传了一张图片（可能是公式截图、手写笔记、教材页面等）。请仔细分析图片内容，识别其中的公式、概念和关键术语。"
	}
	systemPrompt := "你是知识构建助手 knowledge_builder，帮助用户构建知识节点：" +
		imageSegment + "\n现有知识图谱节点：" + nodesCtx + `

请根据用户输入的内容，输出：
PAPERCORE: [简洁的知识核概，30-80字，用第一人称表达理解]
TAGS: [标签1], [标签2], [标签3]

注意：
- Papercore 是个人化的理解总结，不是原文照抄
- Tags 以 # 开头，3-5 个

直接输出以下格式：
PAPERCORE: <内容>
TAGS: <标签列表>`

	// 构建消息：有图片时用 multipart content blocks
	var messages []aiclient.StreamInputMessage
	if hasImage {
		contentBlocks := []aiclient.ContentBlock{{
			Type: "image",
			Source: &aiclient.ImageSource{
				Type:      "base64",
				MediaType: mediaType,
				Data:      imageBase64,
			},
		}}
		if rawContent != "" {
			contentBlocks = append(contentBlocks, aiclient.ContentBlock{Type: "text", Text: rawContent})
		} else {
			contentBlocks = append(contentBlocks, aiclient.ContentBlock{
				Type: "text",
				Text: "请分析这张图片，提取其中的知识概念，生成 Papercore 和 Tags。",
			})
		}
		messages = []aiclient.StreamInputMessage{{Role: "user", Content: contentBlocks}}
	} else {
		messages = []aiclient.StreamInputMessage{{Role: "user", Content: rawContent}}
	}

	cfg := config.Load()
	wrote, _, serr := streamAndWrite(r.Context(), w, cfg.DefaultModel, systemPrompt, messages, 8192)
	if serr != nil {
		log.Printf("Knowledge Builder Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}
	sseDone(w)
}

// ── POST /api/v1/ai/suggest（ai.ts:565-637）─────────────────────────

// suggestFcRow 对应 ai.ts:580-582 的 select('extracted_text, page_number') 行。
type suggestFcRow struct {
	ExtractedText *string `json:"extracted_text"`
	PageNumber    *int    `json:"page_number"`
}

// buildSuggestFileText 对应 ai.ts:584-588：
// rows.map(`[第N页] 文本`).join('\n\n')，page_number 为空/0 时显示 '?'。
func buildSuggestFileText(rows []suggestFcRow) string {
	parts := make([]string, 0, len(rows))
	for _, fc := range rows {
		page := "?"
		if fc.PageNumber != nil && *fc.PageNumber != 0 {
			page = strconv.Itoa(*fc.PageNumber)
		}
		text := ""
		if fc.ExtractedText != nil {
			text = *fc.ExtractedText
		}
		parts = append(parts, "[第"+page+"页] "+text)
	}
	return strings.Join(parts, "\n\n")
}

// handleAISuggest AI 自动填写字段（Papercore/Tags/Relations/ShortName）。
func handleAISuggest(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	field := pslStringify(body["field"])
	currentContent := pslStringify(body["current_content"])
	if !jsTruthy(body["field"]) {
		Error(w, http.StatusBadRequest, "缺少 field 参数")
		return
	}

	ssePrepare(w)

	// 获取文件内容
	fileText := ""
	if draftIDs, isArr := body["draft_ids"].([]any); isArr && len(draftIDs) > 0 {
		client, err := db.Get()
		if err != nil {
			log.Printf("Suggest Error: %v", err)
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		first5 := draftIDs
		if len(first5) > 5 {
			first5 = first5[:5]
		}
		raw, err := aiRowsOrEmpty(client.From(db.TableFileContents).
			Select("extracted_text, page_number").
			In("draft_id", aiInVals(first5)).Rows(r.Context()))
		if err != nil {
			log.Printf("Suggest Error: %v", err)
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		var rows []suggestFcRow
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &rows); err != nil {
				log.Printf("Suggest Error: %v", err)
				Error(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if len(rows) > 0 {
			fileText = buildSuggestFileText(rows)
		}
	}

	// 构建 prompt（文件内容优先，缺省回落 current_content，再缺省占位文案）
	contentOr := fileText
	if contentOr == "" {
		contentOr = currentContent
	}
	contentBlock := contentOr
	if contentBlock == "" {
		contentBlock = "(无文件内容)"
	}
	var systemPrompt string
	switch field {
	case "short_name":
		systemPrompt = "你是知识整理助手，根据以下内容生成一个简短的图谱显示名称（2-8个字）。\n" +
			"文件内容：" + contentBlock + "\n" +
			"直接输出名称，不要解释，不要加引号，不要加任何前缀。只输出2-8个字的中文名称。"
	case "papercore":
		systemPrompt = "你是知识整理助手，根据文件内容生成一句话知识核概（Papercore）。\n" +
			"要求：30-80字，用第一人称表达，体现个人理解，不要照抄原文。\n" +
			"文件内容：" + contentBlock + "\n" +
			"直接输出Papercore，不要前缀，不要解释。"
	case "tags":
		systemPrompt = "你是知识整理助手，从文件内容中提取3-5个标签。\n" +
			"要求：标签以#开头，如 #课堂笔记 #核心概念 #重要公式\n" +
			"文件内容：" + contentBlock + "\n" +
			"直接输出标签列表，不要解释，不要JSON格式。"
	default:
		systemPrompt = "请根据内容给出建议。"
	}

	userContent := contentOr
	if userContent == "" {
		userContent = "请根据系统指令给出建议"
	}

	cfg := config.Load()
	wrote, _, serr := streamAndWrite(r.Context(), w, cfg.DefaultModel, systemPrompt,
		[]aiclient.StreamInputMessage{{Role: "user", Content: userContent}}, 8192)
	if serr != nil {
		log.Printf("Suggest Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}
	sseDone(w)
}

// ── POST /api/v1/ai/suggest-relations（ai.ts:645-750）───────────────

// suggestRelation 是响应里的建议条目（键名与 TS 完全一致）。
type suggestRelation struct {
	NodeID       int      `json:"nodeId"`
	ShortName    string   `json:"short_name"`
	Papercore    string   `json:"papercore"`
	Tags         []string `json:"tags"`
	RelationType string   `json:"relation_type"`
	Score        float64  `json:"score"`
}

// classifiedRel 是 LLM 返回的 { nodeId, relation_type } 条目。
type classifiedRel struct {
	nodeID       int
	relationType string
}

// parseClassified 对应 ai.ts:695-708：取首个 '[' 到末个 ']'（TS 的
// /\[[\s\S]*\]/ 无 g 标志、贪婪匹配），解析 JSON 数组。解析失败返回
// ok=false（TS catch 后保持空数组）。nodeId 为 null / 字符串 / 非整数
// 的条目跳过——JS 里它们匹配不上 scoreMap 的数字键，等价地在合并阶段
// 被过滤、在兜底阶段按 related 处理。
func parseClassified(text string) ([]classifiedRel, bool) {
	start := strings.Index(text, "[")
	end := strings.LastIndex(text, "]")
	if start < 0 || end < start {
		return nil, false
	}
	var raw []json.RawMessage
	if err := json.Unmarshal([]byte(text[start:end+1]), &raw); err != nil {
		return nil, false
	}
	out := []classifiedRel{}
	for _, el := range raw {
		var e struct {
			NodeID       json.RawMessage `json:"nodeId"`
			RelationType string          `json:"relation_type"`
		}
		if err := json.Unmarshal(el, &e); err != nil {
			continue // TS 不可能：JSON.parse 已验证；防御性跳过
		}
		if len(e.NodeID) == 0 || string(e.NodeID) == "null" {
			continue
		}
		var f float64
		if err := json.Unmarshal(e.NodeID, &f); err != nil || f != math.Trunc(f) {
			continue
		}
		out = append(out, classifiedRel{nodeID: int(f), relationType: e.RelationType})
	}
	return out, true
}

// round2 对应 Math.round(x*100)/100。
func round2(x float64) float64 {
	return math.Round(x*100) / 100
}

// handleAISuggestRelations 根据 Papercore 语义搜索相关节点，并用 LLM
// 分类关系类型。响应 { suggestions: [...] }（普通 JSON，非 SSE）。
func handleAISuggestRelations(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	papercore := pslStringify(body["papercore"])
	if !jsTruthy(body["papercore"]) {
		Error(w, http.StatusBadRequest, "缺少 papercore 参数")
		return
	}
	var tags []string
	for _, t := range aiMapSlice(body, "tags") {
		tags = append(tags, pslStringify(t))
	}
	topK := 10
	if v, ok := aiAnyToInt(jsOr(body["topK"], nil)); ok {
		topK = v
	}

	// 1. 语义搜索（TS 的 search 内部 catch 一切错误并返回 []）
	results, serr := retrieval.Unified().Search(r.Context(), papercore, topK, 0.3)
	if serr != nil {
		log.Printf("[UnifiedVectorIndex] Search failed: %v", serr)
		results = nil
	}
	if len(results) == 0 {
		JSON(w, http.StatusOK, struct {
			Suggestions []suggestRelation `json:"suggestions"`
		}{[]suggestRelation{}})
		return
	}

	// 2. 用 LLM 分类关系类型
	candidateLines := make([]string, 0, len(results))
	for _, res := range results {
		candidateLines = append(candidateLines, fmt.Sprintf(
			"[ID:%v] 名称:%s Papercore:%s 标签:%s",
			res.SourceID, jsOr(res.Title, ""),
			pslTruncateRunes(res.Papercore, 80),
			strings.Join(tagsOrEmptyStr(res.Tags), ",")))
	}
	tagsSegment := ""
	if len(tags) > 0 {
		tagsSegment = "\n新节点标签: " + strings.Join(tags, ", ")
	}
	systemPrompt := `你是知识图谱关系分类助手。给定一个新的知识节点，判断它与现有节点的关系类型。

新节点的 Papercore: "` + papercore + `"` + tagsSegment + `

现有候选节点：
` + strings.Join(candidateLines, "\n") + `

请对以上每个候选节点，判断关系类型。关系类型定义：
- prerequisite: 前置知识（需要先学这个节点才能理解新节点）
- related: 相关知识（同一层次的关联概念）
- parent: 上层概念（新节点是这个概念的子集/特例）

返回严格的 JSON 数组格式，不要包含任何其他文字：
[
  {"nodeId": <数字ID>, "relation_type": "prerequisite|related|parent"},
  ...
]

如果某个节点不属于以上任何类型，不要包含它。最多返回5个关系。`

	cfg := config.Load()
	resp, cerr := aiclient.CreateMessage(r.Context(), aiclient.Request{
		Model:     cfg.DefaultModel,
		MaxTokens: 8192,
		System:    systemPrompt,
		Messages:  []aiclient.InputMessage{{Role: "user", Content: "请分析并返回 JSON 数组。"}},
	})
	if cerr != nil {
		log.Printf("SuggestRelations Error: %v", cerr)
		Error(w, http.StatusInternalServerError, cerr.Error())
		return
	}

	// 3. 解析 LLM 响应（thinking 型模型的 content 里可能有非文本块，
	// resp.Text() 已等价 TS 的 filter(type==='text').join('')）
	classified := []classifiedRel{}
	if parsed, pok := parseClassified(resp.Text()); pok {
		classified = parsed
	} else {
		log.Println("[suggest-relations] LLM JSON parse failed, falling back to vector-only")
	}

	// 4. 合并语义分数和 LLM 分类
	scoreMap := map[int]float64{}
	indexByID := map[int]int{}
	for i, res := range results {
		if id, ok := aiAnyToInt(res.SourceID); ok {
			scoreMap[id] = res.Score
			indexByID[id] = i
		}
	}
	suggestions := []suggestRelation{}
	for _, c := range classified {
		score, ok := scoreMap[c.nodeID]
		if !ok {
			continue
		}
		res := results[indexByID[c.nodeID]]
		suggestions = append(suggestions, suggestRelation{
			NodeID:       c.nodeID,
			ShortName:    res.Title,
			Papercore:    res.Papercore,
			Tags:         tagsOrEmptyStr(res.Tags),
			RelationType: c.relationType,
			Score:        round2(score),
		})
	}

	// 5. 没有被 LLM 分类的，标记为 related（降级处理）
	classifiedIDs := map[int]bool{}
	for _, c := range classified {
		classifiedIDs[c.nodeID] = true
	}
	for _, res := range results {
		id, ok := aiAnyToInt(res.SourceID)
		if !ok || classifiedIDs[id] {
			continue
		}
		suggestions = append(suggestions, suggestRelation{
			NodeID:       id,
			ShortName:    res.Title,
			Papercore:    res.Papercore,
			Tags:         tagsOrEmptyStr(res.Tags),
			RelationType: "related",
			Score:        round2(res.Score),
		})
	}

	if len(suggestions) > 8 {
		suggestions = suggestions[:8]
	}
	JSON(w, http.StatusOK, struct {
		Suggestions []suggestRelation `json:"suggestions"`
	}{suggestions})
}

// ── POST /api/v1/ai/generate-reflection（ai.ts:1270-1361）───────────

// reflectionSections 是解析出的 4 个 section。
type reflectionSections struct {
	learningBehavior string
	challengeReport  string
	thinkingPattern  string
	suggestion       string
}

// parsePeriodDays 对应 ai.ts:1120 的
// parseInt(period.replace(/[^0-9]/g, ”)) || 7。
func parsePeriodDays(period string) int {
	var digits strings.Builder
	for _, c := range period {
		if c >= '0' && c <= '9' {
			digits.WriteRune(c)
		}
	}
	n, err := strconv.Atoi(digits.String())
	if err != nil || n == 0 {
		return 7 // Atoi 失败（空串/溢出）或 0（NaN → || 7）
	}
	return n
}

// periodLabel 对应 ai.ts:1190-1196：按字面包含 '3'/'30' 判定，
// period 为空 → '近期'。
func periodLabel(period string) string {
	if period == "" {
		return "近期"
	}
	if strings.Contains(period, "3") {
		return "近三天"
	}
	if strings.Contains(period, "30") {
		return "近一个月"
	}
	return "近一周"
}

// reflectionSince 对应 ai.ts:1119-1122 的 sinceDate 计算
// （days 天前的 UTC 时间；TS 序列化为 ISO 串给 .gte，Go 侧保 time.Time）。
func reflectionSince(period string, now time.Time) time.Time {
	days := parsePeriodDays(period)
	return now.Add(-time.Duration(days) * 24 * time.Hour)
}

// buildReflectionPrompt 对应 ai.ts:1111-1222。
// userID 为空时跳过全部数据源（TS 的 context?.userId 判空）。
func buildReflectionPrompt(ctx context.Context, userID, period string) (string, error) {
	logsContext := ""
	pastReflections := ""
	nodeActivity := ""
	qaLogsContext := ""

	var since *time.Time
	if period != "" {
		s := reflectionSince(period, time.Now())
		since = &s
	}

	if userID != "" {
		client, err := db.Get()
		if err != nil {
			return "", err
		}
		// 规格 2.2：4 类数据采集。TS 对 4 条查询用 .gte('created_at', sinceDate)
		// 做服务端时间过滤；internal/db 的查询构建器未提供 gte（共享包，AI 组
		// 无权扩展），这里取回该用户全部行（已按 created_at 降序）后在内存做
		// 「过滤 → 截断」——与 PostgREST 的服务端组合语义（过滤→排序→limit）
		// 结果一致，代价是多传部分旧行
		logsJSON, err := reflectRowsJSON(ctx, client, db.TablePaperProblemLogs, "*", "user_id", userID, since, 20)
		if err != nil {
			return "", err
		}
		if logsJSON != "[]" {
			var logs []json.RawMessage
			_ = json.Unmarshal([]byte(logsJSON), &logs)
			logsContext = fmt.Sprintf("问题解决记录（%d条）：%s", len(logs), logsJSON)
		}
		qaJSON, err := reflectRowsJSON(ctx, client, db.TableProblemSolvingLogs,
			"question, answer, created_at, confusions, mastered, question_patterns, open_questions, knowledge_links, depth_score",
			"user_id", userID, since, 30)
		if err != nil {
			return "", err
		}
		if qaJSON != "[]" {
			var qa []json.RawMessage
			_ = json.Unmarshal([]byte(qaJSON), &qa)
			qaLogsContext = fmt.Sprintf("问答日志（%d条）：%s", len(qa), qaJSON)
		}
		refJSON, err := reflectRowsJSON(ctx, client, db.TableReflections, "*", "user_id", userID, since, 5)
		if err != nil {
			return "", err
		}
		if refJSON != "[]" {
			var refs []json.RawMessage
			_ = json.Unmarshal([]byte(refJSON), &refs)
			pastReflections = fmt.Sprintf("往期反思（%d条）：%s", len(refs), refJSON)
		}
		nodesJSON, err := reflectRowsJSON(ctx, client, db.TableKnowledgeNodes,
			"id, papercore, short_name, tags, created_at", "user_id", userID, since, 50)
		if err != nil {
			return "", err
		}
		if nodesJSON != "[]" {
			var nodes []json.RawMessage
			_ = json.Unmarshal([]byte(nodesJSON), &nodes)
			nodeActivity = fmt.Sprintf("知识节点活动（%d个）：%s", len(nodes), nodesJSON)
		}
	}

	or := func(s, fallback string) string {
		if s != "" {
			return s
		}
		return fallback
	}
	label := periodLabel(period)

	return `你是学习反思助手 Reflection_mind。

分析用户` + label + `的学习行为，生成包含以下4个维度的反思报告：

` + or(logsContext, "暂无问题记录。") + `
` + or(qaLogsContext, "暂无问答日志。") + `
` + or(pastReflections, "暂无往期反思。") + `
` + or(nodeActivity, "暂无知识节点活动。") + `

请生成以下4个部分，严格按格式输出，每个部分以 "## 标题" 开头（两个 # 号加一个空格加标题），各部分之间空一行：

## 学习行为
<分析用户` + label + `的学习内容与节奏，200-400字>

## 攻克问题
<总结用户` + label + `成功解决的问题，200-400字>

## 思维模式
<分析用户的思维优势与改进点，200-400字>

## 学习建议
<给出具体可操作的学习建议，200-400字>

风格：鼓励、建设性、有洞察力。结合往期反思的内容，避免重复往期已经给出的建议。不要输出任何其他内容（如前言、结语、署名等），直接从 "## 学习行为" 开始输出。`, nil
}

// reflectRowsJSON 拉取单表行集：按 created_at 降序取回后在内存过滤
// since（>=）并截断 limit，序列化为紧凑 JSON 数组（元素保留原始字节，
// 等价 TS 的 JSON.stringify(data)——列序与值格式均不重排）。
func reflectRowsJSON(
	ctx context.Context, client *db.Client, table, cols, eqCol, eqVal string,
	since *time.Time, limit int,
) (string, error) {
	raw, err := aiRowsOrEmpty(client.From(table).Select(cols).
		Eq(eqCol, eqVal).Order("created_at", false).Rows(ctx))
	if err != nil {
		return "", err
	}
	var elems []json.RawMessage
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &elems); err != nil {
			return "", err
		}
	}
	out := make([]json.RawMessage, 0, limit)
	for _, el := range elems {
		if since != nil {
			var row struct {
				CreatedAt time.Time `json:"created_at"`
			}
			if jerr := json.Unmarshal(el, &row); jerr == nil && row.CreatedAt.Before(*since) {
				continue
			}
		}
		out = append(out, el)
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		return "[]", nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// sectionHeaderRe 对应 ai.ts:1250 的 /##\s+(学习行为|攻克问题|思维模式|学习建议)\s*\n/。
var sectionHeaderRe = regexp.MustCompile(`##[` + aiWSClass + `]+(学习行为|攻克问题|思维模式|学习建议)[` + aiWSClass + `]*\n`)

// sectionBoundaryRe 是内容段的结束边界（TS 正则的 (?=\n##\s|\n*$) 前瞻，
// RE2 不支持前瞻，改为手动定位下一个 "\n##"+空白 的起点；尾部换行由
// aiTrimJS 收敛，效果与 \n*$ 相同）。
var sectionBoundaryRe = regexp.MustCompile("\n##[" + aiWSClass + "]")

// parseReflectionSections 对应 ai.ts:1229-1262：解析反思报告的 4 个
// `## 标题\n内容` 段。同一标题重复出现时后写的覆盖（与 TS 循环赋值一致），
// 仅收录非空内容。
// 扫描推进复刻 /g 正则的 lastIndex 语义：TS 的匹配**包含内容段**，下一次
// 匹配从上一段内容结束之后开始——若用 FindAll 只锚定头部，上一段内容里
// 恰好以 "## " 开头时会被再次当成新标题（TS 不会），故手动迭代。
func parseReflectionSections(text string) reflectionSections {
	var result reflectionSections
	keyByTitle := map[string]func(string){
		"学习行为": func(s string) { result.learningBehavior = s },
		"攻克问题": func(s string) { result.challengeReport = s },
		"思维模式": func(s string) { result.thinkingPattern = s },
		"学习建议": func(s string) { result.suggestion = s },
	}
	for pos := 0; pos < len(text); {
		loc := sectionHeaderRe.FindStringSubmatchIndex(text[pos:])
		if loc == nil {
			break
		}
		title := text[pos+loc[2] : pos+loc[3]]
		contentStart := pos + loc[1]
		contentEnd := len(text)
		if b := sectionBoundaryRe.FindStringIndex(text[contentStart:]); b != nil {
			contentEnd = contentStart + b[0]
		}
		content := aiTrimJS(text[contentStart:contentEnd])
		if content != "" {
			if set, ok := keyByTitle[title]; ok {
				set(content)
			}
		}
		pos = contentEnd
	}
	return result
}

// reflectionEcho 透传 reflections 新行的原始 JSON 字段（保持 PostgREST
// 返回的 created_at 等格式字节不重排，等价 TS 的 saved.xxx 直传）。
type reflectionEcho struct {
	ID               json.RawMessage `json:"id"`
	Period           json.RawMessage `json:"period"`
	LearningBehavior json.RawMessage `json:"learning_behavior"`
	ChallengeReport  json.RawMessage `json:"challenge_report"`
	ThinkingPattern  json.RawMessage `json:"thinking_pattern"`
	Suggestion       json.RawMessage `json:"suggestion"`
	CreatedAt        json.RawMessage `json:"created_at"`
}

// handleAIGenerateReflection 生成学习反思报告（SSE 流），结束后解析 4 个
// section 并落库，最后补一条 { done, warning, reflection } 事件。
func handleAIGenerateReflection(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	period := pslStringify(body["period"])
	if !jsTruthy(body["period"]) {
		Error(w, http.StatusBadRequest, "缺少 period 参数")
		return
	}

	userID := auth.UserID(r.Context())
	if userID == "" {
		userID = "guest"
	}

	ssePrepare(w)

	systemPrompt, err := buildReflectionPrompt(r.Context(), userID, period)
	if err != nil {
		log.Printf("GenerateReflection Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 用户消息里的时段文案（ai.ts:1293）
	spanLabel := "近一周"
	if strings.Contains(period, "3") {
		spanLabel = "近三天"
	} else if strings.Contains(period, "30") {
		spanLabel = "近一个月"
	}
	userMessage := "请根据我的" + spanLabel + "的学习数据，生成学习反思报告。"

	cfg := config.Load()
	wrote, fullContent, serr := streamAndWrite(r.Context(), w, cfg.DefaultModel, systemPrompt,
		[]aiclient.StreamInputMessage{{Role: "user", Content: userMessage}}, 16384)
	if serr != nil {
		log.Printf("GenerateReflection Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}

	// 解析4个section
	sections := parseReflectionSections(fullContent)
	parseFailed := sections.learningBehavior == "" || sections.challengeReport == "" ||
		sections.thinkingPattern == "" || sections.suggestion == ""

	// 保存到数据库（raw_text 保留原始全文，解析失败时不丢内容）
	nullIfEmpty := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	client, derr := db.Get()
	if derr != nil {
		log.Printf("Failed to save reflection: %v", derr)
		_ = sseWrite(w, struct {
			Error string `json:"error"`
		}{"保存反思报告失败"})
		sseDone(w)
		return
	}
	savedRaw, saveErr := client.From(db.TableReflections).Insert(r.Context(), map[string]any{
		"learning_behavior": nullIfEmpty(sections.learningBehavior),
		"challenge_report":  nullIfEmpty(sections.challengeReport),
		"thinking_pattern":  nullIfEmpty(sections.thinkingPattern),
		"suggestion":        nullIfEmpty(sections.suggestion),
		"raw_text":          fullContent,
		"period":            period,
		"user_id":           userID,
	})
	if saveErr != nil {
		log.Printf("Failed to save reflection: %v", saveErr)
		_ = sseWrite(w, struct {
			Error string `json:"error"`
		}{"保存反思报告失败"})
	} else {
		var rows []reflectionEcho
		if jerr := json.Unmarshal(savedRaw, &rows); jerr != nil || len(rows) == 0 {
			log.Printf("Failed to save reflection: %v", jerr)
			_ = sseWrite(w, struct {
				Error string `json:"error"`
			}{"保存反思报告失败"})
		} else {
			var warning *string
			if parseFailed {
				warning = strPtr("部分维度解析失败，已保留原始全文（raw_text）")
			}
			_ = sseWrite(w, struct {
				Done       bool           `json:"done"`
				Warning    *string        `json:"warning"`
				Reflection reflectionEcho `json:"reflection"`
			}{true, warning, rows[0]})
		}
	}
	sseDone(w)
}

// ── POST /api/v1/ai/note-helper（ai.ts:1368-1409）───────────────────

// handleAINoteHelper 根据知识节点信息生成笔记内容（SSE 流）。
// TS 此端点不校验参数、且 context 里没有 userId（偏好查询是死路径）。
func handleAINoteHelper(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	contextMap := map[string]any{
		"nodeId":    body["nodeId"],
		"papercore": jsOr(body["papercore"], ""),
		"tags":      jsOr(body["tags"], []any{}),
		"relations": jsOr(body["relations"], map[string]any{}),
	}

	ssePrepare(w)

	systemPrompt, err := buildNoteHelperPrompt(r.Context(), contextMap)
	if err != nil {
		log.Printf("NoteHelper Error: %v", err)
		// TS 此处 catch 直接 res.status(500).json({error:'生成笔记失败'})——
		// 仅在尚未写出任何事件时可行（express headersSent=false）；
		// 流已开始后 TS 会抛 ERR_HTTP_HEADERS_SENT（框架层崩溃），Go 侧
		// 以补 [DONE] 收尾代替（见交付 gaps）
		Error(w, http.StatusInternalServerError, "生成笔记失败")
		return
	}

	cfg := config.Load()
	wrote, _, serr := streamAndWrite(r.Context(), w, cfg.NoteModel, systemPrompt,
		[]aiclient.StreamInputMessage{{Role: "user", Content: "请为这个知识节点生成一份结构化的学习笔记。"}}, 16384)
	if serr != nil {
		log.Printf("NoteHelper Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, "生成笔记失败")
			return
		}
		sseDone(w)
		return
	}
	sseDone(w)
}

// ── POST /api/v1/ai/generate-note（ai.ts:1459-1642）─────────────────

// genNoteSource 是源文件聚合（ai.ts:1489-1491）。
type genNoteSource struct {
	id       any
	typ      string
	title    string
	content  string
	material *db.Material
}

// genNoteCitation 是 /generate-note 尾事件的引用条目（键序与 TS 一致：
// index/sourceId/sourceType/fileName/highlightText/pageNumber）。
// PageNumber 无 omitempty：TS 恒有该键（null 或数字）。
type genNoteCitation struct {
	Index         int    `json:"index"`
	SourceID      any    `json:"sourceId"`
	SourceType    string `json:"sourceType"`
	FileName      string `json:"fileName"`
	HighlightText string `json:"highlightText"`
	PageNumber    any    `json:"pageNumber"`
}

// uploadsPrefixRe 对应 ai.ts:1421 的 /^\/uploads\//。
var uploadsPrefixRe = regexp.MustCompile(`^/uploads/`)

// snippetPageSplitRe 对应 ai.ts:1433 的 /\f+|\n\n+/
// （与 materials 组的 uploadPageSplitRe 同源但过滤规则不同：此处要求
// trim 后非空，splitUploadPages 只滤空串）。
var snippetPageSplitRe = regexp.MustCompile("\f+|\n\n+")

// scoreBestPage 对应 ai.ts:1434-1447：把 snippet 与各页做去空白字符
// 重叠计数，取重叠最大的页（严格大于才更新，保持首个最大页）。
func scoreBestPage(pages []string, snippet string) int {
	snip := map[rune]bool{}
	for _, ch := range snippet {
		if !aiWSRune(ch) {
			snip[ch] = true
		}
	}
	bestPage, bestScore := 1, 0
	for i, page := range pages {
		score := 0
		for _, ch := range page {
			if !aiWSRune(ch) && snip[ch] {
				score++
			}
		}
		if score > bestScore {
			bestScore = score
			bestPage = i + 1
		}
	}
	return bestPage
}

// findPageForSnippet 对应 ai.ts:1415-1452：匹配 material 引用卡片所在
// 页码（issue #4 Task 2）——按 \f/\n\n 切页，与 highlightText 求字符
// 重叠，取重叠最大页。任何一步失败返回 nil（TS catch → null）。
// 优先用入库的提取文本（上传/分类时已产生），缺失才重新提取。
func findPageForSnippet(material db.Material, snippet string) *int {
	uploadsDir := config.Load().UploadDir
	storedPath := ""
	if material.FilePath != nil && *material.FilePath != "" {
		storedPath = *material.FilePath
	} else if material.FileURL != nil {
		storedPath = *material.FileURL
	}
	filePath := ""
	if storedPath != "" {
		candidate := filepath.Join(uploadsDir, uploadsPrefixRe.ReplaceAllString(storedPath, ""))
		if _, err := os.Stat(candidate); err == nil {
			filePath = candidate
		}
	}
	if filePath == "" {
		return nil
	}
	text := ""
	if material.ExtractedText != nil && len([]rune(aiTrimJS(*material.ExtractedText))) >= 5 {
		text = *material.ExtractedText
	} else {
		fileType := ""
		if material.FileType != nil {
			fileType = *material.FileType
		}
		name := ""
		if material.Name != nil {
			name = *material.Name
		}
		extracted, _ := extracttext.ExtractText(filePath, fileType, name)
		text = extracted.Text
	}
	if text == "" {
		return nil
	}
	var pages []string
	for _, p := range snippetPageSplitRe.Split(text, -1) {
		if aiTrimJS(p) != "" {
			pages = append(pages, p)
		}
	}
	if len(pages) <= 1 {
		return intPtr(1)
	}
	best := scoreBestPage(pages, snippet)
	return &best
}

// handleAIGenerateNote 根据多份源文件（学习纪要+资料）生成结构化笔记
// （SSE 流式），结束后补一条含 citations 的元数据事件。
func handleAIGenerateNote(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	sourceIDs := aiMapSlice(body, "sourceIds")
	if len(sourceIDs) == 0 {
		Error(w, http.StatusBadRequest, "请选择至少一份源文件")
		return
	}

	ssePrepare(w)

	uid := pslStringify(body["userId"])
	if uid == "" {
		uid = auth.UserID(r.Context())
	}
	if uid == "" {
		uid = "guest"
	}

	client, derr := db.Get()
	if derr != nil {
		log.Printf("GenerateNote Error: %v", derr)
		Error(w, http.StatusInternalServerError, derr.Error())
		return
	}

	// 1. 获取用户笔记偏好
	stylePreference := ""
	stylesRaw, err := aiRowsOrEmpty(client.From(db.TablePapernoteStyle).
		Select("*").Eq("user_id", uid).Limit(1).Rows(r.Context()))
	if err != nil {
		log.Printf("GenerateNote Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var styles []db.PapernoteStyle
	if len(stylesRaw) > 0 {
		if err := json.Unmarshal(stylesRaw, &styles); err != nil {
			log.Printf("GenerateNote Error: %v", err)
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if len(styles) > 0 {
		general := "无"
		if styles[0].GeneralPreference != nil && *styles[0].GeneralPreference != "" {
			general = *styles[0].GeneralPreference
		}
		stylePreference = "用户笔记偏好：\n- 总偏好：" + general +
			"\n- 学科偏好：\n" +
			noteprefs.FormatSubjectPreferencesForPrompt(styles[0].SubjectPreferences)
	}

	// 2. 获取所有源文件内容
	var sources []genNoteSource
	var citations []genNoteCitation
	citationIndex := 0

	for _, src := range sourceIDs {
		srcMap, ok := src.(map[string]any)
		if !ok {
			continue
		}
		srcID := srcMap["id"]
		idStr := pslStringify(srcID)
		srcType := pslStringify(srcMap["type"])
		if srcType == "study_note" {
			raw, serr := client.From(db.TableStudyNotes).Select("*").Eq("id", idStr).Single().Rows(r.Context())
			if serr != nil {
				var pe *db.PostgrestError
				if !errors.As(serr, &pe) {
					log.Printf("GenerateNote Error: %v", serr)
					Error(w, http.StatusInternalServerError, serr.Error())
					return
				}
				continue // 0 行/PostgREST 错误 → data=null → 跳过（TS 同）
			}
			var note db.StudyNote
			if json.Unmarshal(raw, &note) != nil {
				continue
			}
			content := ""
			if note.Content != nil {
				content = *note.Content
			}
			if len(note.Blocks) > 0 {
				texts := make([]string, 0, len(note.Blocks))
				for _, b := range note.Blocks {
					bm, ok := b.(map[string]any)
					if !ok || pslStringify(bm["type"]) != "text" {
						continue
					}
					texts = append(texts, pslStringify(jsOr(bm["content"], "")))
				}
				content = strings.Join(texts, "\n\n")
			}
			title := "学习纪要"
			if note.Title != nil && *note.Title != "" {
				title = *note.Title
			}
			sources = append(sources, genNoteSource{
				id: srcID, typ: "study_note",
				title:   title,
				content: pslTruncateRunes(content, 3000),
			})
			citationIndex++
			citations = append(citations, genNoteCitation{
				Index:      citationIndex,
				SourceID:   srcID,
				SourceType: "study_note",
				FileName:   title,
			})
		} else if srcType == "material" {
			raw, merr := client.From(db.TableMaterials).Select("*").Eq("id", idStr).Single().Rows(r.Context())
			if merr != nil {
				var pe *db.PostgrestError
				if !errors.As(merr, &pe) {
					log.Printf("GenerateNote Error: %v", merr)
					Error(w, http.StatusInternalServerError, merr.Error())
					return
				}
				continue
			}
			var mat db.Material
			if json.Unmarshal(raw, &mat) != nil {
				continue
			}
			// file_contents：TS 整块 try{}catch{}，任何错误忽略 → 空文本
			fileText := ""
			if fcRaw, fcErr := aiRowsOrEmpty(client.From(db.TableFileContents).
				Select("extracted_text").Eq("draft_id", idStr).Limit(1).Rows(r.Context())); fcErr == nil && len(fcRaw) > 0 {
				var fcRows []struct {
					ExtractedText *string `json:"extracted_text"`
				}
				if json.Unmarshal(fcRaw, &fcRows) == nil && len(fcRows) > 0 && fcRows[0].ExtractedText != nil {
					fileText = *fcRows[0].ExtractedText
				}
			}
			name := "资料" // TS：mat.name || mat.title || '资料'（materials 无 title 列，恒为 undefined）
			if mat.Name != nil && *mat.Name != "" {
				name = *mat.Name
			}
			papercore := ""
			if mat.Papercore != nil {
				papercore = *mat.Papercore
			}
			sources = append(sources, genNoteSource{
				id:       srcID,
				typ:      "material",
				title:    name,
				content:  papercore + "\n" + pslTruncateRunes(fileText, 3000),
				material: &mat,
			})
			citationIndex++
			citations = append(citations, genNoteCitation{
				Index:      citationIndex,
				SourceID:   srcID,
				SourceType: "material",
				FileName:   name,
			})
		}
	}

	if len(sources) == 0 {
		_ = sseWrite(w, struct {
			Error string `json:"error"`
		}{"未找到有效的源文件内容"})
		sseDone(w)
		return
	}

	// 3. 构建 prompt
	sourceTexts := make([]string, 0, len(sources))
	for i, s := range sources {
		typeLabel := "资料"
		if s.typ == "study_note" {
			typeLabel = "学习纪要"
		}
		sourceTexts = append(sourceTexts, fmt.Sprintf(
			"【来源%d】%s（%s）\n%s", i+1, s.title, typeLabel, s.content))
	}
	sourcesText := strings.Join(sourceTexts, "\n\n---\n\n")

	styleBlock := "尚无明确的笔记偏好记录，请用通用高质量笔记格式。"
	if stylePreference != "" {
		styleBlock = stylePreference
	}
	systemPrompt := `你是笔记助手 note_helper。根据用户提供的多份学习资料生成一份结构化的综合笔记。

` + styleBlock + `

笔记要求：
- 使用标题层级组织（# ## ###）
- 重点用**加粗**标记
- 适当使用列表和表格
- 包含关键概念、原理、示例
- 结尾有简短总结
- 在引用某份源文件内容时，在段落末尾标注引用标记，格式为 [来源:N]（N为来源编号）
- 引用编号必须对应下方的来源编号

` + sourcesText + `

请直接生成笔记内容。`

	cfg := config.Load()
	wrote, fullContent, serr := streamAndWrite(r.Context(), w, cfg.NoteModel, systemPrompt,
		[]aiclient.StreamInputMessage{{Role: "user", Content: "请根据以上所有来源资料，生成一份综合学习笔记。"}}, 16384)
	if serr != nil {
		log.Printf("GenerateNote Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}

	// Post-process: extract context snippets around each [来源:N] marker
	// + 为 material 引用匹配页码（issue #4 Task 2）。
	// TS 用 Promise.all 并行；Go 侧串行执行——结果与并行一致
	//（各 citation 互不依赖），避免 extracttext 磁盘缓存的并发写竞争
	for i := range citations {
		cit := &citations[i]
		cit.PageNumber = jsonNull // TS：pageNumber 初始 null（键存在）
		marker := fmt.Sprintf("[来源:%d]", cit.Index)
		snippet := ""
		if idx := jsUTF16IndexOf(fullContent, marker); idx >= 0 {
			// 前后各取 80 字（JS slice 的 UTF-16 码元语义，jsUTF16Slice 精确对齐）
			start := idx - 80
			if start < 0 {
				start = 0
			}
			end := idx + jsUTF16Len(marker) + 80
			snippet = aiTrimJS(newlineRunRe.ReplaceAllString(jsUTF16Slice(fullContent, start, end), " "))
		}
		cit.HighlightText = snippet
		if cit.SourceType == "material" && snippet != "" {
			for si := range sources {
				if sourcesEqualID(sources[si], cit.SourceID) && sources[si].material != nil {
					if pn := findPageForSnippet(*sources[si].material, snippet); pn != nil {
						cit.PageNumber = *pn
					}
					break
				}
			}
		}
	}

	_ = sseWrite(w, struct {
		Citations []genNoteCitation `json:"citations"`
		Done      bool              `json:"done"`
	}{citations, true})
	sseDone(w)
}

// newlineRunRe 对应 ai.ts:1618 的 /\n+/g。
var newlineRunRe = regexp.MustCompile(`\n+`)

// sourcesEqualID 对应 TS 的 `s.id === cit.sourceId`（同源请求体值比较）。
func sourcesEqualID(s genNoteSource, id any) bool {
	if a, ok := id.(float64); ok {
		if b, ok2 := s.id.(float64); ok2 {
			return a == b
		}
		return false
	}
	return pslStringify(s.id) == pslStringify(id)
}

// ── POST /api/v1/ai/refine-note（ai.ts:1649-1803）───────────────────

// refineMarkerRe 对应 ai.ts:1787 的 /\[来源:(\d+)\]/g。
var refineMarkerRe = regexp.MustCompile(`\[来源:(\d+)\]`)

// syncRefineCitations 对应 ai.ts:1782-1790：只保留修正后正文中仍存在的
// [来源:N] 对应的引用卡（原样透传请求里的 citation 对象内容）。
func syncRefineCitations(fullRefined string, rawCitations []json.RawMessage) []json.RawMessage {
	used := map[int]bool{}
	for _, m := range refineMarkerRe.FindAllStringSubmatch(fullRefined, -1) {
		if n, err := strconv.Atoi(m[1]); err == nil {
			used[n] = true
		}
	}
	out := []json.RawMessage{}
	for _, raw := range rawCitations {
		var probe struct {
			Index *float64 `json:"index"`
		}
		if json.Unmarshal(raw, &probe) != nil || probe.Index == nil {
			continue // TS：c.index undefined → has(undefined) 恒 false
		}
		if used[int(*probe.Index)] {
			out = append(out, raw)
		}
	}
	return out
}

// handleAIRefineNote 根据用户修正指令优化笔记（SSE 流式，含偏好提取）。
func handleAIRefineNote(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	currentNote := pslStringify(body["currentNote"])
	refinementPrompt := pslStringify(body["refinementPrompt"])
	if !jsTruthy(body["currentNote"]) || !jsTruthy(body["refinementPrompt"]) {
		Error(w, http.StatusBadRequest, "缺少笔记内容或修正指令")
		return
	}
	var rawCitations []json.RawMessage
	if arr, isArr := body["citations"].([]any); isArr && len(arr) > 0 {
		for _, c := range arr {
			if b, err := json.Marshal(c); err == nil {
				rawCitations = append(rawCitations, b)
			}
		}
	}

	ssePrepare(w)

	uid := pslStringify(body["userId"])
	if uid == "" {
		uid = auth.UserID(r.Context())
	}
	if uid == "" {
		uid = "guest"
	}

	client, derr := db.Get()
	if derr != nil {
		log.Printf("RefineNote Error: %v", derr)
		Error(w, http.StatusInternalServerError, derr.Error())
		return
	}

	// 1. 获取用户偏好
	var existingPrefs any
	stylesRaw, err := aiRowsOrEmpty(client.From(db.TablePapernoteStyle).
		Select("*").Eq("user_id", uid).Limit(1).Rows(r.Context()))
	if err != nil {
		log.Printf("RefineNote Error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var styles []db.PapernoteStyle
	if len(stylesRaw) > 0 {
		if err := json.Unmarshal(stylesRaw, &styles); err != nil {
			log.Printf("RefineNote Error: %v", err)
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if len(styles) > 0 && styles[0].SubjectPreferences != nil {
		existingPrefs = styles[0].SubjectPreferences
	}

	// 2. 从修正指令中提取偏好（issue #4 Task 5）：
	// LLM 优先（含所属学科判断），失败回退关键词规则；按学科分层合并
	extracted := noteprefs.ExtractNotePreferences(r.Context(), refinementPrompt, nil)

	// 3. 保存提取的偏好
	if extracted != nil && len(extracted.Preferences) > 0 {
		mergedPrefs := noteprefs.MergeSubjectPreferences(existingPrefs, extracted.Subject, extracted.Preferences)
		// TS：update/insert 的 PostgREST 错误被忽略（未检查返回值），仍发
		// preferences 事件；网络类错误进 catch 只打日志不发事件
		saveOK := true
		existingRaw, exErr := aiRowsOrEmpty(client.From(db.TablePapernoteStyle).
			Select("id").Eq("user_id", uid).Limit(1).Rows(r.Context()))
		if exErr != nil {
			log.Printf("Failed to save preferences: %v", exErr)
			saveOK = false
		} else {
			var existing []struct {
				ID int `json:"id"`
			}
			if len(existingRaw) > 0 {
				_ = json.Unmarshal(existingRaw, &existing)
			}
			if len(existing) > 0 {
				if _, uerr := client.From(db.TablePapernoteStyle).
					Eq("id", strconv.Itoa(existing[0].ID)).
					Update(r.Context(), map[string]any{
						"subject_preferences": mergedPrefs,
						"updated_at":          jsNowISO(),
					}); uerr != nil {
					var pe *db.PostgrestError
					if !errors.As(uerr, &pe) {
						log.Printf("Failed to save preferences: %v", uerr)
						saveOK = false
					}
				}
			} else if _, ierr := client.From(db.TablePapernoteStyle).
				Insert(r.Context(), map[string]any{
					"user_id":             uid,
					"subject_preferences": mergedPrefs,
				}); ierr != nil {
				var pe *db.PostgrestError
				if !errors.As(ierr, &pe) {
					log.Printf("Failed to save preferences: %v", ierr)
					saveOK = false
				}
			}
		}
		if saveOK {
			_ = sseWrite(w, struct {
				PreferencesExtracted map[string]any `json:"preferences_extracted"`
				PreferencesSubject   string         `json:"preferences_subject"`
			}{extracted.Preferences, extracted.Subject})
		}
	}

	// 4. 构建修正 prompt
	sourcesContext := ""
	if sourceIDs := aiMapSlice(body, "sourceIds"); len(sourceIDs) > 0 {
		var sourcesTexts []string
		for _, src := range sourceIDs {
			srcMap, ok := src.(map[string]any)
			if !ok {
				continue
			}
			idStr := pslStringify(srcMap["id"])
			switch pslStringify(srcMap["type"]) {
			case "study_note":
				raw, serr := client.From(db.TableStudyNotes).
					Select("title, content, blocks").Eq("id", idStr).Single().Rows(r.Context())
				if serr != nil {
					var pe *db.PostgrestError
					if !errors.As(serr, &pe) {
						log.Printf("RefineNote Error: %v", serr)
						Error(w, http.StatusInternalServerError, serr.Error())
						return
					}
					continue
				}
				var note struct {
					Title   *string `json:"title"`
					Content *string `json:"content"`
					Blocks  []any   `json:"blocks"`
				}
				if json.Unmarshal(raw, &note) != nil {
					continue
				}
				content := ""
				if note.Content != nil {
					content = *note.Content
				}
				if len(note.Blocks) > 0 {
					texts := make([]string, 0, len(note.Blocks))
					for _, b := range note.Blocks {
						bm, ok := b.(map[string]any)
						if !ok || pslStringify(bm["type"]) != "text" {
							continue
						}
						texts = append(texts, pslStringify(jsOr(bm["content"], "")))
					}
					content = strings.Join(texts, "\n")
				}
				title := "纪要"
				if note.Title != nil && *note.Title != "" {
					title = *note.Title
				}
				sourcesTexts = append(sourcesTexts,
					"【"+title+"】"+pslTruncateRunes(content, 2000))
			case "material":
				raw, merr := client.From(db.TableMaterials).
					Select("name, papercore").Eq("id", idStr).Single().Rows(r.Context())
				if merr != nil {
					var pe *db.PostgrestError
					if !errors.As(merr, &pe) {
						log.Printf("RefineNote Error: %v", merr)
						Error(w, http.StatusInternalServerError, merr.Error())
						return
					}
					continue
				}
				var mat struct {
					Name      *string `json:"name"`
					Papercore *string `json:"papercore"`
				}
				if json.Unmarshal(raw, &mat) != nil {
					continue
				}
				name := "资料"
				if mat.Name != nil && *mat.Name != "" {
					name = *mat.Name
				}
				papercore := ""
				if mat.Papercore != nil {
					papercore = *mat.Papercore
				}
				sourcesTexts = append(sourcesTexts, "【"+name+"】"+papercore)
			}
		}
		if len(sourcesTexts) > 0 {
			sourcesContext = "\n\n原始参考资料：\n" + strings.Join(sourcesTexts, "\n---\n")
		}
	}

	systemPrompt := `你是笔记助手 note_helper。用户正在优化一份学习笔记，请根据修正指令对笔记进行修改。

修正指令：` + refinementPrompt + `

要求：
- 保持笔记的整体结构
- 仅修改需要调整的部分
- 保留原有的引用标记 [来源:N]
- 如果修正指令涉及格式（如表格、列表），按指令调整
- 如果修正指令要求更详细/更简洁，相应地展开或压缩内容

` + sourcesContext + `

请直接输出修正后的完整笔记，包含所有标题、内容和引用标记。`

	cfg := config.Load()
	wrote, fullRefined, serr := streamAndWrite(r.Context(), w, cfg.NoteModel, systemPrompt,
		[]aiclient.StreamInputMessage{{
			Role:    "user",
			Content: "当前笔记：\n\n" + currentNote + "\n\n请按修正指令修改。",
		}}, 16384)
	if serr != nil {
		log.Printf("RefineNote Error: %v", serr)
		if !wrote {
			Error(w, http.StatusInternalServerError, serr.Error())
			return
		}
		sseDone(w)
		return
	}

	// 修正后引用同步（issue #4 Task 4）：只保留修正后正文中仍存在的 [来源:N]
	var syncedCitations any // TS：初始 null → "citations": null（键存在）
	if rawCitations != nil {
		syncedCitations = syncRefineCitations(fullRefined, rawCitations)
	}
	_ = sseWrite(w, struct {
		Done      bool `json:"done"`
		Citations any  `json:"citations"`
	}{true, syncedCitations})
	sseDone(w)
}

// ── POST /api/v1/ai/refresh-index（ai.ts:1809-1826）─────────────────

// handleAIRefreshIndex 重建知识节点向量索引（同时重建标签库）。
func handleAIRefreshIndex(w http.ResponseWriter, r *http.Request) {
	// 同时重建标签库（新增标签在重启前也要参与加成）
	if err := retrieval.TagStore().BuildFromDatabase(r.Context()); err != nil {
		log.Printf("[Index] TagVectorStore rebuild failed: %v", err)
	}
	if err := retrieval.Unified().BuildIndex(r.Context()); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	JSON(w, http.StatusOK, struct {
		Success   bool `json:"success"`
		NodeCount int  `json:"nodeCount"`
		Ready     bool `json:"ready"`
	}{true, retrieval.Unified().RecordCount(), retrieval.Unified().IsReady()})
}
