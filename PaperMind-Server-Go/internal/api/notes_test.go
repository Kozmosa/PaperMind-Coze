package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
)

// 本文件只覆盖纯逻辑函数与不触达数据库/网络的请求校验分支
// （要求：不写需要网络、数据库或真实上传文件的测试）。
// JSON 数字在 Go 解码后为 float64，期望值一律写 float64(...)。

// ── JS 语义帮助函数 ────────────────────────────────────────────────

func TestJSTruthy(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
	}{
		{"nil 为假", nil, false},
		{"false 为假", false, false},
		{"true 为真", true, true},
		{"0 为假", float64(0), false},
		{"非零数字为真", float64(0.5), true},
		{"负数为真", float64(-1), true},
		{"空字符串为假", "", false},
		{"非空字符串为真", "a", true},
		{"空数组为真（JS 语义）", []any{}, true},
		{"空对象为真（JS 语义）", map[string]any{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jsTruthy(tt.in); got != tt.want {
				t.Fatalf("jsTruthy(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestJSOr(t *testing.T) {
	tests := []struct {
		name     string
		v        any
		fallback any
		want     any
	}{
		{"null 兜底", nil, "", ""},
		{"空串兜底", "", "x", "x"},
		{"0 兜底", float64(0), nil, nil},
		{"truthy 原样保留", "keep", "x", "keep"},
		{"空数组原样保留", []any{}, []any{1}, []any{}},
		{"空对象原样保留", map[string]any{}, map[string]any{"a": float64(1)}, map[string]any{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jsOr(tt.v, tt.fallback); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("jsOr(%v, %v) = %v, want %v", tt.v, tt.fallback, got, tt.want)
			}
		})
	}
}

func TestJsNowISO(t *testing.T) {
	s := jsNowISO()
	// 形如 2026-10-15T08:09:10.123Z：毫秒精度、UTC、Z 结尾
	if !strings.HasSuffix(s, "Z") || len(s) != len("2006-01-02T15:04:05.000Z") {
		t.Fatalf("jsNowISO() = %q, want ISO 毫秒精度 UTC 格式", s)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", s); err != nil {
		t.Fatalf("jsNowISO() 输出不可解析: %v", err)
	}
}

// ── tags 清洗（study-notes.ts:49）──────────────────────────────────

func TestCleanNoteTags(t *testing.T) {
	tests := []struct {
		name    string
		in      any
		want    []string
		wantErr bool
	}{
		{"nil 输入为空数组", nil, []string{}, false},
		{"false 输入为空数组", false, []string{}, false},
		{"空数组", []any{}, []string{}, false},
		{"去 # 前缀与两端空白", []any{"#a", " b ", "", "#c#d"}, []string{"a", "b", "c#d"}, false},
		{"全角空白也 trim", []any{"\u3000x\u3000"}, []string{"x"}, false},
		{"纯 # 与纯空白被过滤", []any{"#", " "}, []string{}, false},
		{"非字符串元素报错（TS TypeError→500）", []any{"a", float64(1)}, nil, true},
		{"字符串输入报错（无 .map）", "abc", nil, true},
		{"对象输入报错（无 .map）", map[string]any{}, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := cleanNoteTags(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("cleanNoteTags(%v) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("cleanNoteTags(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// ── parseInt（forums.ts:68）────────────────────────────────────────

func TestParseJSInt(t *testing.T) {
	tests := []struct {
		in   string
		want any
	}{
		{"12", 12},
		{"12abc", 12}, // parseInt 前缀解析
		{"abc", nil},  // NaN → null
		{"", nil},
		{"-5", -5},
		{"+3", 3},
		{"08", 8},
		{"12.9", 12},
		{"1e3", 1},
		{"  7", 7},
		{"0x10", 0},                   // 已知差异：JS parseInt 得 16，此处按十进制前缀取 0
		{"99999999999999999999", nil}, // 已知差异：溢出按 NaN → null
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := parseJSInt(tt.in); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseJSInt(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// ── 关键词回退规则（note-preferences.ts:21-36）────────────────────

func TestNotePrefExtractByKeywords(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want map[string]any
	}{
		{"详细", "请更详细一些", map[string]any{"detail_level": "high"}},
		{"展开+表格", "展开成表格对比", map[string]any{"detail_level": "high", "prefer_tables": true}},
		{"简洁覆盖同类", "更简洁", map[string]any{"detail_level": "concise"}},
		{"概括", "请概括", map[string]any{"detail_level": "concise"}},
		{"示例/举例", "多举例子", map[string]any{"prefer_examples": true}},
		{"重点+通俗", "突出重点，通俗一点", map[string]any{"emphasize_keypoints": true, "language_style": "plain"}},
		{"简单", "写简单点", map[string]any{"language_style": "plain"}},
		{"无关键词", "hello world", map[string]any{}},
		{"空串", "", map[string]any{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := notePrefExtractByKeywords(tt.in); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("notePrefExtractByKeywords(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// ── 学科分层归一化/合并（note-preferences.ts:107-134）──────────────

func TestNotePrefNormalize(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want map[string]any
	}{
		{"null 返回空对象", nil, map[string]any{}},
		{"数组返回空对象", []any{float64(1)}, map[string]any{}},
		{"标量返回空对象", "str", map[string]any{}},
		{"旧平铺结构归入通用层",
			map[string]any{"detail_level": "high"},
			map[string]any{notePrefGeneralSubject: map[string]any{"detail_level": "high"}}},
		{"已是分层的原样保留",
			map[string]any{"数学": map[string]any{"prefer_tables": true}},
			map[string]any{"数学": map[string]any{"prefer_tables": true}}},
		{"混合：平铺归通用，分层保留",
			map[string]any{"数学": map[string]any{"a": float64(1)}, "detail_level": "high"},
			map[string]any{
				"数学":                   map[string]any{"a": float64(1)},
				notePrefGeneralSubject: map[string]any{"detail_level": "high"},
			}},
		{"通用层已有值覆盖平铺同名键（{...flat, ...layered}）",
			map[string]any{notePrefGeneralSubject: map[string]any{"detail_level": "concise"}, "prefer_tables": true},
			map[string]any{notePrefGeneralSubject: map[string]any{"detail_level": "concise", "prefer_tables": true}}},
		{"数组值属于平铺",
			map[string]any{"tags": []any{float64(1)}},
			map[string]any{notePrefGeneralSubject: map[string]any{"tags": []any{float64(1)}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := notePrefNormalize(tt.in); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("notePrefNormalize(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestNotePrefMerge(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		subject string
		prefs   map[string]any
		want    map[string]any
	}{
		{"空数据新建学科层",
			nil, "数学", map[string]any{"a": float64(1)},
			map[string]any{"数学": map[string]any{"a": float64(1)}}},
		{"合并进已有学科层",
			map[string]any{"数学": map[string]any{"a": float64(1)}}, "数学", map[string]any{"b": float64(2)},
			map[string]any{"数学": map[string]any{"a": float64(1), "b": float64(2)}}},
		{"新偏好覆盖旧值",
			map[string]any{"数学": map[string]any{"a": float64(1)}}, "数学", map[string]any{"a": float64(9)},
			map[string]any{"数学": map[string]any{"a": float64(9)}}},
		{"空白 subject 回退通用",
			nil, "  ", map[string]any{"x": float64(1)},
			map[string]any{notePrefGeneralSubject: map[string]any{"x": float64(1)}}},
		{"平铺旧数据先归一化再分层",
			map[string]any{"detail_level": "high"}, "数学", map[string]any{"a": float64(1)},
			map[string]any{
				notePrefGeneralSubject: map[string]any{"detail_level": "high"},
				"数学":                   map[string]any{"a": float64(1)},
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := notePrefMerge(tt.raw, tt.subject, tt.prefs); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("notePrefMerge(%v, %q, %v) = %v, want %v", tt.raw, tt.subject, tt.prefs, got, tt.want)
			}
		})
	}
}

// ── LLM 响应解析（note-preferences.ts:72-93）──────────────────────

func TestNotePrefParseLLMText(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		wantFound   bool
		wantSubject string
		wantPrefs   map[string]any
		wantErr     bool
	}{
		{"完整输出（含 summary 并入偏好）",
			`{"subject":"数学","preferences":{"detail_level":"high"},"summary":"要详细"}`,
			true, "数学",
			map[string]any{"detail_level": "high", "summary": "要详细"}, false},
		{"LLM 明确判定无偏好（返回 null 语义）",
			`{"subject":null,"preferences":{}}`,
			false, "", nil, false},
		{"preferences 非对象视为无偏好（已知差异：TS 会透传数组）",
			`{"subject":"数学","preferences":[1,2]}`,
			false, "", nil, false},
		{"subject 空白回退通用",
			`{"subject":"  ","preferences":{"prefer_tables":true}}`,
			true, notePrefGeneralSubject,
			map[string]any{"prefer_tables": true}, false},
		{"subject 非字符串回退通用",
			`{"subject":123,"preferences":{"prefer_tables":true}}`,
			true, notePrefGeneralSubject,
			map[string]any{"prefer_tables": true}, false},
		{"summary 空串不并入偏好",
			`{"subject":"数学","preferences":{"a":1},"summary":""}`,
			true, "数学",
			map[string]any{"a": float64(1)}, false},
		{"前后杂讯文本中提取 JSON",
			"好的，结果如下：\n{\"subject\":\"数学\",\"preferences\":{\"detail_level\":\"high\"}}\n谢谢",
			true, "数学",
			map[string]any{"detail_level": "high"}, false},
		{"无 JSON 报错（触发关键词回退）",
			"没有任何花括号", false, "", nil, true},
		{"JSON 语法错误报错",
			`{subject:数学}`, false, "", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := notePrefParseLLMText(tt.in, notePrefGeneralSubject)
			if (err != nil) != tt.wantErr {
				t.Fatalf("notePrefParseLLMText(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if got.found != tt.wantFound {
				t.Fatalf("found = %v, want %v", got.found, tt.wantFound)
			}
			if tt.wantFound {
				if got.subject != tt.wantSubject {
					t.Fatalf("subject = %q, want %q", got.subject, tt.wantSubject)
				}
				if !reflect.DeepEqual(got.preferences, tt.wantPrefs) {
					t.Fatalf("preferences = %v, want %v", got.preferences, tt.wantPrefs)
				}
			}
		})
	}
}

// ── 不触达 DB 的请求校验分支（各路由 400/401/guest 分支）──────────

// doHandler 构造带指定 userId 与请求体的请求并执行 handler，
// 返回状态码与去除尾部换行的响应体。
func doHandler(t *testing.T, method, target, userID, body string, fn http.HandlerFunc) (int, string) {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	if userID != "" {
		req = req.WithContext(auth.WithUserID(context.Background(), userID))
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func TestNotesValidationHandlers(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		target     string
		userID     string
		body       string
		fn         http.HandlerFunc
		wantStatus int
		wantBody   string
	}{
		// papernote-style.ts:18-20 — 未登录（无 userId / guest）返回 200 {"data":null}
		{"papernote-style GET 无用户", http.MethodGet, "/api/v1/papernote-style", "", "", handlePapernoteStyleGet, 200, `{"data":null}`},
		{"papernote-style GET guest", http.MethodGet, "/api/v1/papernote-style", "guest", "", handlePapernoteStyleGet, 200, `{"data":null}`},
		// papernote-style.ts:38-40 — PUT 未登录 401
		{"papernote-style PUT guest 401", http.MethodPut, "/api/v1/papernote-style", "guest", "", handlePapernoteStylePut, 401, `{"error":"需要登录"}`},
		{"papernote-style PUT 无用户 401", http.MethodPut, "/api/v1/papernote-style", "", "", handlePapernoteStylePut, 401, `{"error":"需要登录"}`},
		// papernote-style.ts:92-94 — extract 缺修正指令 400（在 LLM 调用之前）
		{"papernote-style extract 缺指令", http.MethodPost, "/api/v1/papernote-style/extract", "user-1", `{}`, handlePapernoteStyleExtract, 400, `{"error":"缺少修正指令"}`},
		{"papernote-style extract guest 401", http.MethodPost, "/api/v1/papernote-style/extract", "guest", `{}`, handlePapernoteStyleExtract, 401, `{"error":"需要登录"}`},
		// knowledge-nodes.ts:50 — papercore 缺失 400
		{"knowledge-nodes POST 缺 papercore", http.MethodPost, "/api/v1/knowledge-nodes", "user-1", `{}`, handleKnowledgeNodesCreate, 400, `{"error":"Papercore 不能为空"}`},
		{"knowledge-nodes POST papercore 空串", http.MethodPost, "/api/v1/knowledge-nodes", "user-1", `{"papercore":""}`, handleKnowledgeNodesCreate, 400, `{"error":"Papercore 不能为空"}`},
		{"knowledge-nodes POST 非法 JSON", http.MethodPost, "/api/v1/knowledge-nodes", "user-1", `not json`, handleKnowledgeNodesCreate, 400, `{"error":"invalid character 'o' in literal null (expecting 'u')"}`},
		// draft-pool.ts:28 — content 缺失 400
		{"draft-pool POST 缺 content", http.MethodPost, "/api/v1/draft-pool", "user-1", `{}`, handleDraftPoolCreate, 400, `{"error":"内容不能为空"}`},
		// stickynotes.ts:30 — papercore 缺失 400
		{"stickynotes POST 缺 papercore", http.MethodPost, "/api/v1/stickynotes", "user-1", `{}`, handleStickynotesCreate, 400, `{"error":"内容不能为空"}`},
		// forums.ts:28 — name/type 缺失 400
		{"forums POST 缺名称", http.MethodPost, "/api/v1/forums", "", `{}`, handleForumsCreate, 400, `{"error":"名称和类型不能为空"}`},
		{"forums POST 仅名称", http.MethodPost, "/api/v1/forums", "", `{"name":"x"}`, handleForumsCreate, 400, `{"error":"名称和类型不能为空"}`},
		{"forums POST 仅类型", http.MethodPost, "/api/v1/forums", "", `{"type":"subject"}`, handleForumsCreate, 400, `{"error":"名称和类型不能为空"}`},
		// forums.ts:63 — title/content 缺失 400
		{"forum posts POST 缺标题", http.MethodPost, "/api/v1/forums/1/posts", "", `{}`, handleForumPostsCreate, 400, `{"error":"标题和内容不能为空"}`},
		{"forum posts POST 缺内容", http.MethodPost, "/api/v1/forums/1/posts", "", `{"title":"t"}`, handleForumPostsCreate, 400, `{"error":"标题和内容不能为空"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, body := doHandler(t, tt.method, tt.target, tt.userID, tt.body, tt.fn)
			if status != tt.wantStatus {
				t.Fatalf("status = %d, want %d（body=%s）", status, tt.wantStatus, body)
			}
			if tt.wantBody != "" && body != tt.wantBody {
				t.Fatalf("body = %s, want %s", body, tt.wantBody)
			}
		})
	}
}

// TestNotesBodyDecodeEdgeCases 覆盖 decodeJSONObjectBody 的边界：
// JSON null/数组/标量按空对象处理（TS 对 null 会 TypeError→500，对数组/
// 标量解构出 undefined 字段，差异见交付说明）。
func TestNotesBodyDecodeEdgeCases(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantBody   string
	}{
		{"JSON null 按空对象（→ 字段缺失 400）", `null`, 400, `{"error":"Papercore 不能为空"}`},
		{"JSON 数组按空对象", `[]`, 400, `{"error":"Papercore 不能为空"}`},
		{"JSON 字符串按空对象", `"hello"`, 400, `{"error":"Papercore 不能为空"}`},
		{"空 body 解析失败 400", ``, 400, `{"error":"EOF"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, body := doHandler(t, http.MethodPost, "/api/v1/knowledge-nodes",
				"user-1", tt.body, handleKnowledgeNodesCreate)
			if status != tt.wantStatus {
				t.Fatalf("status = %d, want %d（body=%s）", status, tt.wantStatus, body)
			}
			if body != tt.wantBody {
				t.Fatalf("body = %s, want %s", body, tt.wantBody)
			}
		})
	}
}
