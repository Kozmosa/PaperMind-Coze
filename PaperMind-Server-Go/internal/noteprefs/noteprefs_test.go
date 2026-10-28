package noteprefs

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/aiclient"
)

// stubLLM 替换包级 createMessage 测试缝，测试结束后还原。
// 返回的 stub 直接构造 Response（同包可见 textBlock）。
func stubLLM(t *testing.T, fn func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error)) {
	t.Helper()
	orig := createMessage
	createMessage = fn
	t.Cleanup(func() { createMessage = orig })
}

// textResponse 构造只有一个文本块的 Response。Content 元素类型未导出，
// 经 JSON 反序列化构造（与真实链路同一路径）。
func textResponse(t *testing.T, s string) *aiclient.Response {
	t.Helper()
	var resp aiclient.Response
	payload := `{"content":[{"type":"text","text":` + strconv.Quote(s) + `}]}`
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		t.Fatalf("unmarshal text response: %v", err)
	}
	return &resp
}

func TestExtractPreferencesByKeywords(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   map[string]any
	}{
		{"空指令无偏好", "", map[string]any{}},
		{"详细", "请更详细一些", map[string]any{"detail_level": "high"}},
		{"展开/更多同组词", "再展开讲讲，给更多内容", map[string]any{"detail_level": "high"}},
		{"简洁覆盖详细（后写胜出）", "详细但更简洁", map[string]any{"detail_level": "concise"}},
		{"表格对比", "用表格对比一下", map[string]any{"prefer_tables": true}},
		{"例子", "多举例子", map[string]any{"prefer_examples": true}},
		{"重点", "突出重点", map[string]any{"emphasize_keypoints": true}},
		{"通俗", "说得更通俗", map[string]any{"language_style": "plain"}},
		{
			"全命中",
			"更详细，用表格对比，多举例子，突出重点，讲通俗点",
			map[string]any{
				"detail_level": "high", "prefer_tables": true,
				"prefer_examples": true, "emphasize_keypoints": true,
				"language_style": "plain",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractPreferencesByKeywords(tt.prompt)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNormalizeSubjectPreferences(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want map[string]map[string]any
	}{
		{"null 归空", nil, map[string]map[string]any{}},
		{"数组归空", []any{"x"}, map[string]map[string]any{}},
		{"标量归空", "x", map[string]map[string]any{}},
		{
			"旧平铺归入通用",
			map[string]any{"detail_level": "high"},
			map[string]map[string]any{"通用": {"detail_level": "high"}},
		},
		{
			"平铺的 null 值同样归入通用层",
			map[string]any{"prefer_tables": nil},
			map[string]map[string]any{"通用": {"prefer_tables": nil}},
		},
		{
			"已是分层原样保留",
			map[string]any{"数学": map[string]any{"detail_level": "high"}},
			map[string]map[string]any{"数学": map[string]any{"detail_level": "high"}},
		},
		{
			"混合：平铺进通用、分层保留，且已有通用层覆盖平铺同名键",
			map[string]any{
				"数学":           map[string]any{"detail_level": "concise"},
				"detail_level": "high",
				"通用":           map[string]any{"detail_level": "formal", "prefer_tables": true},
			},
			map[string]map[string]any{
				"数学": {"detail_level": "concise"},
				"通用": {"detail_level": "formal", "prefer_tables": true},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeSubjectPreferences(tt.raw)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestMergeSubjectPreferences(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		subject string
		prefs   map[string]any
		want    map[string]map[string]any
	}{
		{
			"空底新学科",
			nil, "数学", map[string]any{"detail_level": "high"},
			map[string]map[string]any{"数学": map[string]any{"detail_level": "high"}},
		},
		{
			"同学科新值覆盖旧值",
			map[string]any{"数学": map[string]any{"detail_level": "high", "prefer_tables": true}},
			"数学", map[string]any{"detail_level": "concise"},
			map[string]map[string]any{"数学": {"detail_level": "concise", "prefer_tables": true}},
		},
		{
			"空白 subject 归通用",
			map[string]any{"数学": map[string]any{"detail_level": "high"}},
			"  ", map[string]any{"prefer_examples": true},
			map[string]map[string]any{
				"数学": {"detail_level": "high"},
				"通用": {"prefer_examples": true},
			},
		},
		{
			"subject 带空白被裁剪",
			nil, " 物理 ", map[string]any{"language_style": "plain"},
			map[string]map[string]any{"物理": {"language_style": "plain"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MergeSubjectPreferences(tt.raw, tt.subject, tt.prefs)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestFormatSubjectPreferencesForPrompt(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want string
	}{
		{"空为无", nil, "无"},
		{"平铺渲染", map[string]any{"detail_level": "high"}, "通用：detail_level=high"},
		{
			"布尔与数字按 JSON 字面量",
			map[string]any{"prefer_tables": true, "depth": float64(3)},
			"通用：depth=3、prefer_tables=true",
		},
		{
			"分层多行、学科按 key 排序（Go 确定性；TS 为插入序）",
			map[string]any{
				"数学": map[string]any{"detail_level": "high"},
				"通用": map[string]any{"language_style": "plain"},
			},
			"数学：detail_level=high\n通用：language_style=plain",
		},
		{
			"对象值取紧凑 JSON",
			map[string]any{"数学": map[string]any{"nested": map[string]any{"a": float64(1)}}},
			`数学：nested={"a":1}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FormatSubjectPreferencesForPrompt(tt.raw)
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExtractNotePreferencesLLMPaths(t *testing.T) {
	tests := []struct {
		name    string
		options *Options
		llmResp func() (*aiclient.Response, error)
		llmErr  error
		want    *ExtractedNotePreference
	}{
		{
			name: "LLM 正常返回：学科+偏好+summary 并入",
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `前缀噪声 {"subject":"数学","preferences":{"detail_level":"high"},"summary":"要详细"} 后缀`), nil
			},
			want: &ExtractedNotePreference{
				Subject: "数学",
				Preferences: map[string]any{
					"detail_level": "high", "summary": "要详细",
				},
			},
		},
		{
			name:    "subject 缺省回落 hints[0]",
			options: &Options{SubjectHints: []string{"", "复分析"}},
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `{"subject":null,"preferences":{"prefer_tables":true}}`), nil
			},
			want: &ExtractedNotePreference{
				Subject:     "复分析",
				Preferences: map[string]any{"prefer_tables": true},
			},
		},
		{
			name: "无 hints 时 subject 回落通用",
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `{"subject":"  ","preferences":{"prefer_examples":true}}`), nil
			},
			want: &ExtractedNotePreference{
				Subject:     GeneralSubject,
				Preferences: map[string]any{"prefer_examples": true},
			},
		},
		{
			name: "preferences 为空对象 → null（LLM 判定无偏好）",
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `{"subject":null,"preferences":{}}`), nil
			},
			want: nil,
		},
		{
			name: "preferences 为数组 → null（TS Object.keys([]) 为空的等价行为）",
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `{"subject":"数学","preferences":[1,2]}`), nil
			},
			want: nil,
		},
		{
			name: "summary 为空字符串不并入",
			llmResp: func() (*aiclient.Response, error) {
				return textResponse(t, `{"subject":"数学","preferences":{"a":1},"summary":""}`), nil
			},
			want: &ExtractedNotePreference{
				Subject:     "数学",
				Preferences: map[string]any{"a": float64(1)},
			},
		},
		{
			name:   "LLM 报错 → 关键词回退",
			llmErr: errors.New("ANTHROPIC_API_KEY is not set"),
			want: &ExtractedNotePreference{
				Subject:     GeneralSubject,
				Preferences: map[string]any{"detail_level": "high"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stubLLM(t, func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error) {
				if tt.llmResp != nil {
					return tt.llmResp()
				}
				return nil, tt.llmErr
			})
			got := ExtractNotePreferences(context.Background(), "请写得更详细", tt.options)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestExtractNotePreferencesFallbackNoKeywords(t *testing.T) {
	stubLLM(t, func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error) {
		return nil, errors.New("connection error")
	})
	if got := ExtractNotePreferences(context.Background(), "把第二段的公式改成最新版本", nil); got != nil {
		t.Fatalf("got %#v, want nil（无可提取偏好）", got)
	}
}

func TestExtractNotePreferencesNoJSONObjectFallsBack(t *testing.T) {
	stubLLM(t, func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error) {
		return textResponse(t, "抱歉，我没有理解"), nil // 无 {} → throw → 回退
	})
	got := ExtractNotePreferences(context.Background(), "简洁一点", nil)
	want := &ExtractedNotePreference{
		Subject:     GeneralSubject,
		Preferences: map[string]any{"detail_level": "concise"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestExtractNotePreferencesMalformedJSONFallsBack(t *testing.T) {
	stubLLM(t, func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error) {
		return textResponse(t, `{"subject":"数学","preferences":`), nil // 截断 JSON
	})
	got := ExtractNotePreferences(context.Background(), "用表格对比", nil)
	want := &ExtractedNotePreference{
		Subject:     GeneralSubject,
		Preferences: map[string]any{"prefer_tables": true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestExtractNotePreferencesRequestShape(t *testing.T) {
	var gotReq aiclient.Request
	stubLLM(t, func(ctx context.Context, req aiclient.Request) (*aiclient.Response, error) {
		gotReq = req
		return textResponse(t, `{"subject":null,"preferences":{}}`), nil
	})
	_ = ExtractNotePreferences(context.Background(), "更详细", &Options{SubjectHints: []string{"数学"}})
	if gotReq.MaxTokens != 8192 {
		t.Fatalf("max_tokens = %d, want 8192", gotReq.MaxTokens)
	}
	if gotReq.Temperature != 0 { // TS 不传 temperature
		t.Fatalf("temperature = %v, want 0", gotReq.Temperature)
	}
	if len(gotReq.Messages) != 1 || gotReq.Messages[0].Content != "修正指令：更详细" {
		t.Fatalf("messages = %+v", gotReq.Messages)
	}
	if !strings.Contains(gotReq.System, "源文件学科标签供参考：数学。") {
		t.Fatalf("system 缺少 hints 插值段: %q", gotReq.System)
	}
	if !strings.Contains(gotReq.System, `无法判断填 "通用"`) {
		t.Fatalf("system 缺少学科判断句: %q", gotReq.System)
	}
}
