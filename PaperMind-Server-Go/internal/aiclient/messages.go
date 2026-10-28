// Package aiclient 提供对 server/src/config/ai.ts 中 Anthropic 客户端的最小
// 等价移植：Anthropic 兼容 Messages API 的非流式调用。
//
// 当前消费方：记录组（problem-solving-logs /summarize、note-preferences）。
// ai.go（AI 组）的 SSE 流式链路如需扩展请在别处实现，勿改本包公开签名。
//
// 行为依据 config/ai.ts:27-40：
//   - ANTHROPIC_API_KEY 缺失时不初始化客户端，任何调用即抛
//     "ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口"
//     （TS 用 Proxy 实现，Go 用 ErrAPIKeyMissing，路由侧 500 透传该文案）
//   - ANTHROPIC_BASE_URL 可选；缺省直连官方 https://api.anthropic.com
//   - 单请求超时 120s；SDK 自动重试降为 1 次（issue #7 Task 3）：
//     网络错误 / 408 / 409 / 429 / 5xx 重试一次，其余 4xx 不重试
package aiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

const (
	// defaultBaseURL 对应 @anthropic-ai/sdk 未传 baseURL 时的官方端点。
	defaultBaseURL = "https://api.anthropic.com"
	// anthropicVersion 是 SDK 默认携带的协议版本头。
	anthropicVersion = "2023-06-01"
	// requestTimeout 对应 ai.ts:33 的 timeout: 120_000（单次请求）。
	requestTimeout = 120 * time.Second
	// maxRetries 对应 ai.ts:34 的 maxRetries: 1（首次失败后再重试一次）。
	maxRetries = 1
	// retryDelay 两次尝试间的等待（SDK 指数退避起步 ~0.5s，取固定值）。
	retryDelay = 500 * time.Millisecond
)

// ErrAPIKeyMissing 等价 ai.ts:36-40 Proxy 抛错的原文（调用方把它透传成
// 500 {"error": ...}，文案与 TS 完全一致）。
var ErrAPIKeyMissing = errors.New(
	"ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口")

// 测试缝：单测中替换以隔离真实环境变量与网络（同包 _test 内还原）。
var (
	loadConfig = config.Load
	httpDo     = func(req *http.Request) (*http.Response, error) {
		return (&http.Client{Timeout: requestTimeout}).Do(req)
	}
)

// InputMessage 是 messages 数组元素（纯文本 content，对应 TS 的
// messages: [{ role: 'user', content: prompt }] 写法）。
type InputMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Request 对应 anthropic.messages.create 入参的记录组用到的子集。
// Temperature 为 0 值时省略（等价 TS 不传该字段）。
type Request struct {
	Model       string         `json:"model"`
	MaxTokens   int            `json:"max_tokens"`
	Temperature float64        `json:"temperature,omitempty"`
	System      string         `json:"system,omitempty"`
	Messages    []InputMessage `json:"messages"`
}

// textBlock 是响应 content 数组里的文本块；其余块类型只保留 type 判别。
type textBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Response 只解出记录组关心的 content 块；id/usage 等字段忽略。
type Response struct {
	Content []textBlock `json:"content"`
}

// Text 拼接全部 type=="text" 块，对应 TS 的
// resp.content.filter(x => x.type === 'text').map(x => x.text).join(”)。
func (r *Response) Text() string {
	var sb strings.Builder
	for _, b := range r.Content {
		if b.Type == "text" {
			sb.WriteString(b.Text)
		}
	}
	return sb.String()
}

// apiHTTPError 是网关返回非 2xx 时的错误；message 取响应体 error.message
// （对齐 TS SDK 抛出 APIError 的 .message，供路由 500 透传）。
type apiHTTPError struct {
	statusCode int
	message    string
}

func (e *apiHTTPError) Error() string {
	// 网关/代理偶发返回空响应体的非 2xx（对拍实测踩过：代理未稳时空体
	// 4xx）。空 message 若不兜底，日志与 500 响应都会变成空字符串。
	if e.message == "" {
		return fmt.Sprintf("AI gateway HTTP %d (empty error body)", e.statusCode)
	}
	return e.message
}

// retryable 判定是否触发 SDK 语义的重试：网络类错误，或 408/409/429/5xx。
func retryable(err error) bool {
	var apiErr *apiHTTPError
	if errors.As(err, &apiErr) {
		return apiErr.statusCode == http.StatusRequestTimeout ||
			apiErr.statusCode == http.StatusConflict ||
			apiErr.statusCode == http.StatusTooManyRequests ||
			apiErr.statusCode >= 500
	}
	return true // 无 HTTP 状态 ⇒ 连接类错误
}

// CreateMessage 调用 POST {baseURL}/v1/messages 并返回解析后的响应。
func CreateMessage(ctx context.Context, req Request) (*Response, error) {
	cfg := loadConfig()
	if cfg.AnthropicAPIKey == "" {
		return nil, ErrAPIKeyMissing
	}
	base := strings.TrimRight(cfg.AnthropicBaseURL, "/")
	if base == "" {
		base = defaultBaseURL
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(retryDelay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		resp, err := doOnce(ctx, base, cfg.AnthropicAPIKey, payload)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !retryable(err) {
			return nil, err
		}
	}
	return nil, lastErr
}

// doOnce 发送单次请求。非 2xx 时解析响应体的 error.message 作为错误文案。
func doOnce(ctx context.Context, base, apiKey string, payload []byte) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := httpDo(req)
	if err != nil {
		return nil, err // 网络类错误：交给上层按 SDK 语义重试
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(data))
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &body) == nil && body.Error.Message != "" {
			msg = body.Error.Message
		}
		return nil, &apiHTTPError{statusCode: resp.StatusCode, message: msg}
	}

	var out Response
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
