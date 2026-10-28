package aiclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// 本文件与 messages_test.go 共用 stubConfig 测试缝（同包内定义）。

func TestStreamMessageParsesTextDeltas(t *testing.T) {
	// 逐事件对齐 Anthropic SSE：非 text_delta 事件（message_start /
	// thinking 块 / content_block_stop / ping）必须被过滤，等价
	// ai.ts:78 `event.type === 'content_block_delta' && event.delta.type === 'text_delta'`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_start\n" +
			`data: {"type":"message_start","message":{"id":"msg_1"}}` + "\n\n" +
			"event: content_block_start\n" +
			`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}` + "\n\n" +
			"event: content_block_delta\n" +
			`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理"}}` + "\n\n" +
			"event: content_block_delta\n" +
			`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}` + "\n\n" +
			"event: content_block_delta\n" +
			`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"，世界"}}` + "\n\n" +
			"event: content_block_stop\n" +
			`data: {"type":"content_block_stop","index":1}` + "\n\n" +
			"event: message_stop\n" +
			`data: {"type":"message_stop"}` + "\n\n"))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "sk-test", AnthropicBaseURL: srv.URL})

	var got []string
	if err := StreamMessage(context.Background(), StreamRequest{
		Model: "m", MaxTokens: 64,
		Messages: []StreamInputMessage{{Role: "user", Content: "hi"}},
	}, func(text string) error {
		got = append(got, text)
		return nil
	}); err != nil {
		t.Fatalf("StreamMessage: %v", err)
	}
	if strings.Join(got, "") != "你好，世界" {
		t.Fatalf("deltas = %q, want 你好，世界", got)
	}
}

func TestStreamMessageRequestShapeAndContentBlocks(t *testing.T) {
	var gotPath, gotMethod, gotAPIKey, gotVersion, gotAccept string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		gotAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		gotAccept = r.Header.Get("Accept")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"type":"message_stop"}` + "\n\n"))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "sk-test", AnthropicBaseURL: srv.URL})

	err := StreamMessage(context.Background(), StreamRequest{
		Model: "kimi-for-coding", MaxTokens: 16384, System: "sys",
		Messages: []StreamInputMessage{{
			Role: "user",
			Content: []ContentBlock{
				{Type: "image", Source: &ImageSource{Type: "base64", MediaType: "image/png", Data: "QUJD"}},
				{Type: "text", Text: "这道题怎么解"},
			},
		}},
	}, func(string) error { return nil })
	if err != nil {
		t.Fatalf("StreamMessage: %v", err)
	}
	if gotPath != "/v1/messages" || gotMethod != http.MethodPost {
		t.Fatalf("request = %s %s, want POST /v1/messages", gotMethod, gotPath)
	}
	if gotAPIKey != "sk-test" || gotVersion != "2023-06-01" ||
		!strings.HasPrefix(gotAccept, "text/event-stream") {
		t.Fatalf("headers: key=%q version=%q accept=%q", gotAPIKey, gotVersion, gotAccept)
	}
	if gotBody["stream"] != true {
		t.Fatalf("stream = %v, want true", gotBody["stream"])
	}
	if gotBody["model"] != "kimi-for-coding" || gotBody["max_tokens"] != float64(16384) {
		t.Fatalf("body = %v", gotBody)
	}
	msgs := gotBody["messages"].([]any)
	content := msgs[0].(map[string]any)["content"].([]any)
	img := content[0].(map[string]any)
	if img["type"] != "image" {
		t.Fatalf("first block = %v, want image", img)
	}
	src := img["source"].(map[string]any)
	if src["type"] != "base64" || src["media_type"] != "image/png" || src["data"] != "QUJD" {
		t.Fatalf("image source = %v", src)
	}
	if txt := content[1].(map[string]any); txt["type"] != "text" || txt["text"] != "这道题怎么解" {
		t.Fatalf("text block = %v", txt)
	}
}

func TestStreamMessageMissingAPIKey(t *testing.T) {
	stubConfig(t, &config.Config{})
	err := StreamMessage(context.Background(), StreamRequest{Model: "m", MaxTokens: 8},
		func(string) error { return nil })
	if !errors.Is(err, ErrAPIKeyMissing) {
		t.Fatalf("err = %v, want ErrAPIKeyMissing", err)
	}
}

func TestStreamMessageRetriesOnceOn500(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"upstream boom"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}` + "\n\n" +
			`data: {"type":"message_stop"}` + "\n\n"))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: srv.URL})

	var full strings.Builder
	if err := StreamMessage(context.Background(), StreamRequest{Model: "m", MaxTokens: 8},
		func(text string) error { full.WriteString(text); return nil }); err != nil {
		t.Fatalf("StreamMessage: %v", err)
	}
	if full.String() != "ok" || hits.Load() != 2 {
		t.Fatalf("full=%q hits=%d, want ok/2", full.String(), hits.Load())
	}
}

func TestStreamMessageNoRetryOn400(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"bad input"}}`))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: srv.URL})

	err := StreamMessage(context.Background(), StreamRequest{Model: "m", MaxTokens: 8},
		func(string) error { return nil })
	if err == nil || err.Error() != "bad input" {
		t.Fatalf("err = %v, want 'bad input'", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("hits = %d, want 1（4xx 不重试）", hits.Load())
	}
}

func TestStreamMessageMidStreamErrorEvent(t *testing.T) {
	// 网关在流中途报错：TS 的 for-await 会抛出进路由 catch（补 [DONE]），
	// Go 侧等价返回携带 error.message 的 error
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"部分"}}` + "\n\n" +
			`data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` + "\n\n"))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: srv.URL})

	err := StreamMessage(context.Background(), StreamRequest{Model: "m", MaxTokens: 8},
		func(string) error { return nil })
	if err == nil || err.Error() != "Overloaded" {
		t.Fatalf("err = %v, want 'Overloaded'", err)
	}
}

func TestConsumeSSEReader(t *testing.T) {
	// 纯解析层测试：CRLF 行尾、event: 行忽略、非 JSON data 跳过、
	// OpenAI 习惯的 [DONE] 防御性终止、EOF 正常结束
	input := "event: ping\r\n" +
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\r\n\r\n" +
		": keep-alive comment\n\n" +
		"data: not-json\n\n" +
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"b\"}}\n\n"
	var got []string
	if err := consumeSSEReader(nopReadCloser{strings.NewReader(input)}, func(text string) error {
		got = append(got, text)
		return nil
	}); err != nil {
		t.Fatalf("consumeSSEReader: %v", err)
	}
	if strings.Join(got, "") != "ab" {
		t.Fatalf("got = %q, want ab", got)
	}

	got = nil
	if err := consumeSSEReader(nopReadCloser{strings.NewReader("data: [DONE]\n\n")},
		func(text string) error { got = append(got, text); return nil }); err != nil {
		t.Fatalf("consumeSSEReader [DONE]: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("[DONE] should end stream without deltas, got %q", got)
	}
}

func TestConsumeSSEReaderAbortOnCallbackError(t *testing.T) {
	// onDelta 返回错误（客户端断开时 Write 失败）应立即中止流
	input := "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"y\"}}\n\n"
	wantErr := errors.New("client gone")
	err := consumeSSEReader(nopReadCloser{strings.NewReader(input)}, func(string) error {
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
}

// nopReadCloser 把 Reader 适配为 ReadCloser（Close 无操作）。
type nopReadCloser struct {
	r interface{ Read([]byte) (int, error) }
}

func (c nopReadCloser) Read(p []byte) (int, error) { return c.r.Read(p) }
func (c nopReadCloser) Close() error               { return nil }
