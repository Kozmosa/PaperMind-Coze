// Package api 提供 /api/v1 路由骨架与统一响应助手。
//
// 响应格式完全复刻 TS 侧约定（依据：knowledge-nodes.ts:23/25、
// draft-pool.ts:16/28、chat-sessions.ts:20/23、control-center.ts:32、
// materials.ts:253、ai.ts:39/43/79/83 等实际调用点）：
//
//   - 成功（列表/详情）:  200 {"data": <任意 JSON>}
//   - 创建成功:          201 {"data": ...}（多数路由；chat-sessions 等为 200）
//   - 失败:              400/401/404/500 {"error": "<消息字符串>"}
//   - 删除/标记类:        200 {"success": true}
//   - SSE（ai/chat、ai/tutor）: 头 text/event-stream; charset=utf-8 +
//     Cache-Control: no-cache, no-store, no-transform, must-revalidate +
//     Connection: keep-alive；逐块 `data: {"content":"..."}\n\n`，结束 `data: [DONE]\n\n`
//   - upload 返回扁平对象（fileKey/fileUrl/fileName/...），无 data 包装
package api

import (
	"encoding/json"
	"log"
	"net/http"
)

// dataEnvelope 对应 TS 的 res.json({ data })。
type dataEnvelope struct {
	Data any `json:"data"`
}

// errorEnvelope 对应 TS 的 res.status(n).json({ error: msg })。
type errorEnvelope struct {
	Error string `json:"error"`
}

// successEnvelope 对应 TS 的 res.json({ success: true })。
type successEnvelope struct {
	Success bool `json:"success"`
}

// JSON 写任意 JSON 响应。编码失败必须记日志：WriteHeader 已发出，
// 此时静默吞错会产出 200+空体（对拍曾因空 RawMessage 触发）。
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("respond: encode json (status %d): %v", status, err)
	}
}

// Data 写 {"data": ...} 成功响应（对应 res.json({ data })）。
func Data(w http.ResponseWriter, status int, data any) {
	JSON(w, status, dataEnvelope{Data: data})
}

// OK 写 200 {"data": ...}。
func OK(w http.ResponseWriter, data any) { Data(w, http.StatusOK, data) }

// Created 写 201 {"data": ...}（对应 res.status(201).json({ data })）。
func Created(w http.ResponseWriter, data any) { Data(w, http.StatusCreated, data) }

// Error 写 {"error": msg}（对应 res.status(n).json({ error: err.message })）。
func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, errorEnvelope{Error: msg})
}

// Err 便捷封装：err 为 nil 时写 500 "internal error"。
func Err(w http.ResponseWriter, status int, err error) {
	msg := "internal error"
	if err != nil {
		msg = err.Error()
	}
	Error(w, status, msg)
}

// SuccessTrue 写 200 {"success": true}（control-center mark-viewed、
// materials/study-notes delete 等用）。
func SuccessTrue(w http.ResponseWriter) {
	JSON(w, http.StatusOK, successEnvelope{Success: true})
}

// NotImplemented 地基阶段各业务组的统一桩响应：501 {"error": "Not Implemented: <route>"}。
func NotImplemented(w http.ResponseWriter, route string) {
	Error(w, http.StatusNotImplemented, "Not Implemented: "+route)
}

// NotImplementedHandler 返回指定路由的 501 桩 handler，供各组注册文件使用。
func NotImplementedHandler(route string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		NotImplemented(w, route)
	}
}

// ── SSE 助手（对应 ai.ts:43-45、111-113 的响应头设置）────────────────

// StartSSE 设置 SSE 响应头并提交 200。
func StartSSE(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-store, no-transform, must-revalidate")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
}

// WriteSSE 写一个 `data: <json>\n\n` 事件（对应 res.write(`data: ${JSON.stringify(...)}`)）。
func WriteSSE(w http.ResponseWriter, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = w.Write([]byte("data: " + string(b) + "\n\n"))
	return err
}

// WriteSSEDone 写结束标记 `data: [DONE]\n\n`（对应 ai.ts:83）。
func WriteSSEDone(w http.ResponseWriter) {
	_, _ = w.Write([]byte("data: [DONE]\n\n"))
}
