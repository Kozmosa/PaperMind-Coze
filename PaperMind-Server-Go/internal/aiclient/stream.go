package aiclient

// stream.go — Anthropic 兼容 Messages API 的 SSE 流式调用，
// 对等移植 server/src/routes/ai.ts 里 `anthropic.messages.stream(...)` 的用法
//（for await + content_block_delta/text_delta 过滤）。
//
// 行为契约（对齐 @anthropic-ai/sdk + config/ai.ts:27-40）：
//   - ANTHROPIC_API_KEY 缺失 → ErrAPIKeyMissing（文案与 TS Proxy 抛错逐字一致）
//   - 单次尝试 120s 上限只覆盖「发出请求 → 收到响应头」阶段；SDK 的 timeout
//     在 fetch resolve 后清除，流体读取不受限时（若用 http.Client.Timeout 会
//     把长流整体掐断在 120s，与 TS 不符）
//   - 自动重试 1 次：网络错误 / 408 / 409 / 429 / 5xx，且只发生在响应头收到
//     之前；一旦开始消费流体，错误直接上抛（路由侧补 data: [DONE] 收尾）
//   - 只把 delta.type == "text_delta" 的增量交给回调；其余事件类型
//     （message_start / content_block_start / ping / thinking 块等）静默跳过，
//     等价 TS 路由里 `if (event.type === 'content_block_delta' && ...)` 的过滤

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// ImageSource 对应 Anthropic multipart content blocks 里的
// source: { type: 'base64', media_type, data }（ai.ts:129/523）。
type ImageSource struct {
	Type      string `json:"type"` // 固定 "base64"
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// ContentBlock 是 content 数组元素：文本块或图片块（ai.ts:129-131/520-531）。
type ContentBlock struct {
	Type   string       `json:"type"` // "text" | "image"
	Text   string       `json:"text,omitempty"`
	Source *ImageSource `json:"source,omitempty"`
}

// StreamInputMessage 的 Content 为 string（纯文本）或 []ContentBlock
// （图片+文本混排），对应 TS 里 messages: [{ role, content }] 两种写法。
type StreamInputMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// StreamRequest 对应 anthropic.messages.stream 入参的 AI 组用到的子集。
type StreamRequest struct {
	Model     string               `json:"model"`
	MaxTokens int                  `json:"max_tokens"`
	System    string               `json:"system,omitempty"`
	Messages  []StreamInputMessage `json:"messages"`
	// Stream 由 StreamMessage 强制置 true（SDK 的 stream 模式自动携带该字段）。
	Stream bool `json:"stream"`
}

// streamHTTPDo 是流式专用测试缝：客户端不设整体 Timeout，120s 上限由
// streamStart 里的计时器控制到「响应头」为止（见文件头注释）。
var streamHTTPDo = func(req *http.Request) (*http.Response, error) {
	return (&http.Client{}).Do(req)
}

// errStreamDone 表示收到 message_stop，流正常结束（内部哨兵，不外泄）。
var errStreamDone = errors.New("aiclient: message_stop")

// StreamMessage 发起流式请求，逐个 text delta 调用 onDelta；
// onDelta 返回错误时立即中止（客户端断开时 http.ResponseWriter 写失败）。
func StreamMessage(ctx context.Context, req StreamRequest, onDelta func(text string) error) error {
	cfg := loadConfig()
	if cfg.AnthropicAPIKey == "" {
		return ErrAPIKeyMissing
	}
	base := strings.TrimRight(cfg.AnthropicBaseURL, "/")
	if base == "" {
		base = defaultBaseURL
	}
	req.Stream = true
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(retryDelay):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		resp, err := streamStart(ctx, base, cfg.AnthropicAPIKey, payload)
		if err != nil {
			lastErr = err
			if !retryable(err) {
				return err
			}
			continue
		}
		// 2xx：开始消费流体；此后出错不再重试（响应头已收到，SDK 同此语义）
		return consumeSSEReader(resp.Body, onDelta)
	}
	return lastErr
}

// cancelBody 在 Body.Close 时释放每尝试独立的 context（120s 计时器停止后，
// 这是该 ctx 的唯一收尾出口；父 ctx 取消仍会即时中止读取）。
type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

// streamStart 发送单次流式请求并等到响应头。非 2xx 时读取并解析错误体
// （复用 CreateMessage 的 apiHTTPError 语义）；2xx 时停止 120s 计时器。
func streamStart(ctx context.Context, base, apiKey string, payload []byte) (*http.Response, error) {
	reqCtx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(requestTimeout, cancel)

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		base+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		timer.Stop()
		cancel()
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := streamHTTPDo(req)
	if err != nil {
		timer.Stop()
		cancel()
		return nil, err // 网络类错误：交上层按 SDK 语义重试
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		timer.Stop()
		cancel()
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
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
	// 对应 TS SDK：fetch resolve（收到响应头）后清除 timeout，流体读取不限时
	timer.Stop()
	resp.Body = &cancelBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

// consumeSSEReader 逐行解析 SSE 流。只关心 `data: {...}` 行；Anthropic 每个
// 事件单行 data，`event: xxx` 行与空行按 SSE 惯例忽略。
func consumeSSEReader(r io.ReadCloser, onDelta func(string) error) error {
	defer r.Close()
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if trimmed := strings.TrimRight(line, "\r\n"); strings.HasPrefix(trimmed, "data:") {
			payload := strings.TrimSpace(trimmed[len("data:"):])
			// Anthropic 不发 [DONE]（OpenAI 习惯），防御性识别避免死循环
			if payload == "[DONE]" {
				return nil
			}
			if herr := handleEventData(payload, onDelta); herr != nil {
				if errors.Is(herr, errStreamDone) {
					return nil
				}
				return herr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil // 对端关闭：TS 的 async iterator 同样以 return 结束
			}
			return err
		}
	}
}

// handleEventData 解析单个事件的 JSON 载荷。结构不完整/非 JSON 的行
// （注释、心跳负载）静默跳过——等价 TS 路由只匹配 text_delta 的过滤。
func handleEventData(payload string, onDelta func(string) error) error {
	var ev struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(payload), &ev) != nil {
		return nil
	}
	switch {
	case ev.Type == "content_block_delta" && ev.Delta != nil && ev.Delta.Type == "text_delta":
		return onDelta(ev.Delta.Text)
	case ev.Type == "message_stop":
		return errStreamDone
	case ev.Type == "error":
		// 网关在流中途报错（如上游过载）：对齐 SDK 抛错的 message 字段
		msg := "stream error"
		if ev.Error != nil && ev.Error.Message != "" {
			msg = ev.Error.Message
		}
		return errors.New(msg)
	}
	return nil
}
