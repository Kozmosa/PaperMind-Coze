package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// ── 知识构建组（knowledgebuilder*.go）───────────────────────────────
// TS 源：server/src/routes/knowledge-builder.ts（2961 行）。
// 文件拆分（同包多文件）：
//   - knowledgebuilder.go          路由注册 + process-content 导出入口
//   - knowledgebuilder_js.go       JS 字符串语义助手（UTF-16 长度/slice/trim）
//   - knowledgebuilder_helpers.go  纯逻辑助手（stripTOC/逻辑路径/垃圾标签等）
//   - knowledgebuilder_tags.go     DB 标签层（层级提取/L3 检索/知识节点同步）
//   - knowledgebuilder_pipeline.go LLM 管线（papercore 生成 + 全局定位/局部演化）
//   - knowledgebuilder_reprocess.go reprocess-material / 批处理两个路由
//   - knowledgebuilder_graph.go    graph-data / tag-documents
//   - knowledgebuilder_rebuild.go  trigger / consolidate-tags / rebuild-all / 迁移
//
// userId 兜底对照 TS：process-content(:886)/reprocess-material(:1232)/
// graph-data(:1645)/tag-documents(:2102)/rebuild-all(:2383)/consolidate-tags(:2894)
// 是 `(req as any).userId || 'guest'` → writeUserID；process-study-notes(:1428)/
// process-materials(:1521)/trigger(:2198) 不兜底（userId 为空时不加 user_id
// 过滤或不过滤，逐路由对照）。
//
// supabase 调用错误语义（本组贯穿）：TS 侧 postgrest-js 对 PostgREST 业务
// 错误（4xx/42703/PGRST116 等）返回 {data:null, error} 不抛异常，对网络类
// 失败 reject。因此凡 TS 只解构 data / 完全不解构的调用，Go 侧用
// kbSwallowPostgrest 吞掉 *db.PostgrestError（数据按空处理）、网络错误上抛；
// 显式检查 error 的调用逐分支对齐。

// ProcessContentRequest 是 handleProcessContent 的入参契约
// （knowledge-builder.ts:886 起；upload.ts:194-196 的调用形状：
// body { type: 'material', id }，无 file_content）。
type ProcessContentRequest struct {
	Type   string `json:"type"` // 'material' | 'study_note'
	ID     int    `json:"id"`
	UserID string `json:"-"` // 由调用方注入（auth 上下文），不来自 JSON
}

// ProcessContentResult 是 ProcessContent 的返回值：Status 为 TS 侧
// res.status(...).json(...) 的最终状态码（成功路径 200），Body 为完整
// 响应体（{"data":...} 或 {"error":...}）。upload 后台分类只需检查
// Status >= 400（upload.ts:207-209 的 fakeRes._status 判定）。
type ProcessContentResult struct {
	Status int
	Body   json.RawMessage
}

// ProcessContent 是 upload 路由后台分类的直调入口，对应 upload.ts:187-216
// 以 fake req/res 调 handleProcessContent 的内部调用：完整执行分类管线并
// 返回状态码与响应体，不写任何 HTTP 连接（PORTING.md：勿 HTTP 自调）。
// 分类涉及多次 LLM 调用（几十秒），调用方应放入后台 goroutine 执行；
// 成功路径由本函数自己写 process_status='processed'，失败标记由本函数
// 内部与调用方（Status>=400 时）共同兜底。
func ProcessContent(ctx context.Context, req ProcessContentRequest, fileContent string) ProcessContentResult {
	// 导出入口的 type/id 都是确定类型；idRaw 传 int 保证响应体里 id 是数字
	// （TS 透传 body.id，RN 客户端依赖其类型）；eq 过滤串在内部派生
	status, body := kbProcessContent(ctx, req.Type, req.ID, req.UserID, fileContent)
	raw, err := json.Marshal(body)
	if err != nil {
		raw = []byte(`{"error":"` + err.Error() + `"}`)
		status = http.StatusInternalServerError
	}
	return ProcessContentResult{Status: status, Body: raw}
}

// registerKnowledgeBuilderRoutes 注册知识构建组全部路由（router.go 调用）。
func registerKnowledgeBuilderRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/knowledge-builder/process-content",
		handleKnowledgeBuilderProcessContent)
	mux.HandleFunc("POST /api/v1/knowledge-builder/reprocess-material",
		handleKnowledgeBuilderReprocessMaterial)
	mux.HandleFunc("POST /api/v1/knowledge-builder/process-study-notes",
		handleKnowledgeBuilderProcessStudyNotes)
	mux.HandleFunc("POST /api/v1/knowledge-builder/process-materials",
		handleKnowledgeBuilderProcessMaterials)
	mux.HandleFunc("GET /api/v1/knowledge-builder/graph-data",
		handleKnowledgeBuilderGraphData)
	mux.HandleFunc("GET /api/v1/knowledge-builder/tag-documents",
		handleKnowledgeBuilderTagDocuments)
	mux.HandleFunc("POST /api/v1/knowledge-builder/trigger",
		handleKnowledgeBuilderTrigger)
	mux.HandleFunc("POST /api/v1/knowledge-builder/rebuild-all",
		handleKnowledgeBuilderRebuildAll)
	mux.HandleFunc("POST /api/v1/knowledge-builder/consolidate-tags",
		handleKnowledgeBuilderConsolidateTags)
	mux.HandleFunc("POST /api/v1/knowledge-builder/migrate-add-conflict-column",
		handleKnowledgeBuilderMigrateConflictColumn)
}

// handleKnowledgeBuilderProcessContent 单条内容分类入库。
// 对应 knowledge-builder.ts:886-1227（导出 handler 供 upload 直调——
// Go 侧等价物是本包导出的 ProcessContent 函数）。
func handleKnowledgeBuilderProcessContent(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	userID := writeUserID(auth.UserID(r.Context()))
	// TS 解构 { type, id, file_content }；非字符串 type 走 400 分支
	// （kbProcessContent 内按 JS 严格等价判定）
	status, resp := kbProcessContent(r.Context(), body["type"], body["id"], userID, kbBodyString(body["file_content"]))
	JSON(w, status, resp)
}

// kbBodyString 取请求体的字符串字段：非字符串/缺失按空串处理。
// TS 对非字符串 file_content 调 .trim() 会抛 TypeError→500，RN 客户端
// 只发字符串，此处归一为空串（行为差异极小，见交付 gaps）。
func kbBodyString(v any) string {
	s, _ := v.(string)
	return s
}

// kbProcessContent 是 handleProcessContent 的完整移植（含 TS 的 catch-all：
// 管线中途异常时标记 process_status='failed' 后返回 500）。
// idRaw 保留原始 JSON 值用于响应体（数字 id 响应仍是数字）。
func kbProcessContent(ctx context.Context, typ, idRaw any, userID, fileContent string) (int, any) {
	status, resp, err := kbProcessContentInner(ctx, typ, idRaw, kbIDString(idRaw), userID, fileContent)
	if err != nil {
		log.Printf("process-content error: %v", err)
		// 管线中途异常：标记 failed，保持 ai_processed=false 供批次重试
		//（knowledge-builder.ts:1215-1222，从请求体重新派生 type/id，无 user_id 过滤）
		if jsTruthy(typ) && jsTruthy(idRaw) {
			if client, cErr := db.Get(); cErr == nil {
				// TS：t === 'study_note' ? 'study_notes' : 'materials'（非字符串一律 materials）
				table := db.TableMaterials
				if ts, isStr := typ.(string); isStr && ts == "study_note" {
					table = db.TableStudyNotes
				}
				_, _ = client.From(table).Eq("id", kbIDString(idRaw)).
					Update(context.Background(), map[string]any{"process_status": "failed"})
			}
		}
		return http.StatusInternalServerError, map[string]any{"error": err.Error()}
	}
	return status, resp
}

// kbIDString 把请求体的 id 归一为 eq 过滤字符串（数字 5 → "5"，
// 对应 TS eq('id', 5) 的 URL 形态）；复用 records.go 的 recIDString。
func kbIDString(v any) string {
	return recIDString(v)
}
