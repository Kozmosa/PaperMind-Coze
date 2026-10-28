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

// stubConfig 替换包级 loadConfig 测试缝，测试结束后还原。
func stubConfig(t *testing.T, cfg *config.Config) {
	t.Helper()
	orig := loadConfig
	loadConfig = func() *config.Config { return cfg }
	t.Cleanup(func() { loadConfig = orig })
}

func TestErrAPIKeyMissingMessageMatchesTS(t *testing.T) {
	// ai.ts:36-40 Proxy 抛错原文，路由 500 会透传该字符串，必须逐字一致
	want := "ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口"
	if ErrAPIKeyMissing.Error() != want {
		t.Fatalf("ErrAPIKeyMissing = %q, want %q", ErrAPIKeyMissing.Error(), want)
	}
}

func TestCreateMessageMissingAPIKey(t *testing.T) {
	stubConfig(t, &config.Config{})
	_, err := CreateMessage(context.Background(), Request{
		Model: "m", MaxTokens: 10,
		Messages: []InputMessage{{Role: "user", Content: "hi"}},
	})
	if !errors.Is(err, ErrAPIKeyMissing) {
		t.Fatalf("err = %v, want ErrAPIKeyMissing", err)
	}
}

func TestCreateMessageRequestShapeAndTextJoin(t *testing.T) {
	var gotPath, gotMethod, gotAPIKey, gotVersion, gotCT string
	var gotBody Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		gotAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"你好"},
			{"type":"tool_use","text":"忽略"},{"type":"text","text":"世界"}]}`))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "sk-test", AnthropicBaseURL: srv.URL})

	resp, err := CreateMessage(context.Background(), Request{
		Model: "m", MaxTokens: 4096, Temperature: 0.3, System: "sys",
		Messages: []InputMessage{{Role: "user", Content: "prompt"}},
	})
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if resp.Text() != "你好世界" {
		t.Fatalf("Text() = %q, want %q", resp.Text(), "你好世界")
	}
	if gotPath != "/v1/messages" || gotMethod != http.MethodPost {
		t.Fatalf("request = %s %s, want POST /v1/messages", gotMethod, gotPath)
	}
	if gotAPIKey != "sk-test" || gotVersion != "2023-06-01" ||
		!strings.HasPrefix(gotCT, "application/json") {
		t.Fatalf("headers: apikey=%q version=%q ct=%q", gotAPIKey, gotVersion, gotCT)
	}
	if gotBody.MaxTokens != 4096 || gotBody.Temperature != 0.3 || gotBody.System != "sys" ||
		len(gotBody.Messages) != 1 || gotBody.Messages[0].Content != "prompt" {
		t.Fatalf("decoded body = %+v", gotBody)
	}
}

func TestCreateMessageRetriesOnceOn500(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: srv.URL})

	resp, err := CreateMessage(context.Background(), Request{Model: "m", MaxTokens: 8})
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if resp.Text() != "ok" || hits.Load() != 2 {
		t.Fatalf("Text=%q hits=%d, want ok/2", resp.Text(), hits.Load())
	}
}

func TestCreateMessageNoRetryOn400(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"bad input"}}`))
	}))
	defer srv.Close()
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: srv.URL})

	_, err := CreateMessage(context.Background(), Request{Model: "m", MaxTokens: 8})
	if err == nil || err.Error() != "bad input" {
		t.Fatalf("err = %v, want 'bad input'", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("hits = %d, want 1（4xx 不重试）", hits.Load())
	}
}

func TestCreateMessageDefaultBaseURLWhenUnset(t *testing.T) {
	// baseURL 未配置时必须落到官方端点（对应 SDK 缺省行为）；
	// 用 httpDo 测试缝拦截请求，不发出真实网络调用。
	stubConfig(t, &config.Config{AnthropicAPIKey: "k", AnthropicBaseURL: ""})
	origDo := httpDo
	var gotURL string
	httpDo = func(req *http.Request) (*http.Response, error) {
		gotURL = req.URL.String()
		return nil, errors.New("stop: captured")
	}
	t.Cleanup(func() { httpDo = origDo })

	_, _ = CreateMessage(context.Background(), Request{Model: "m", MaxTokens: 8})
	if gotURL != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("url = %q, want https://api.anthropic.com/v1/messages", gotURL)
	}
}

func TestAPIHTTPErrorEmptyMessageFallback(t *testing.T) {
	// 网关/代理空响应体的非 2xx：Error() 必须兜底出非空文案，
	// 否则日志与 500 透传都是空字符串（对拍实测踩过）。
	got := (&apiHTTPError{statusCode: 502, message: ""}).Error()
	if got == "" || !strings.Contains(got, "502") {
		t.Fatalf("Error() = %q, want non-empty fallback containing status 502", got)
	}
	if (&apiHTTPError{statusCode: 400, message: "boom"}).Error() != "boom" {
		t.Fatalf("non-empty message must pass through unchanged")
	}
}
