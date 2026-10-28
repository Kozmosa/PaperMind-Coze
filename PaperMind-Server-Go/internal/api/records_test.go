package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// ── /summarize 的 prompt 与解析（problem-solving-logs.ts:10-74）────────

// pslSummaryPromptWantTS 逐字对照 problem-solving-logs.ts:14-29 的模板，
// 防止提示词在移植中被无意改动。
const pslSummaryPromptWantTS = `你是学习分析专家。以下是一名学生与智能导师的一段完整对话。请把这段对话总结为一份学习认知快照，严格输出 JSON（不要 markdown 代码块）：

对话：
%s

输出 JSON 字段要求：
{
  "question": "学生本次对话的核心问题（一句概括，50字内）",
  "summary": "200-300字总结：问题脉络（问过什么、按什么顺序、如何推进）+ 认知变化（从什么状态到什么状态）",
  "mastered": ["学生已掌握/理解正确的概念（最多5个，没有则空数组）"],
  "confusions": ["学生暴露出的混淆点/错误理解/薄弱环节（最多5个）"],
  "question_patterns": ["提问模式标签，从以下类型选1-3个：概念辨析型、公式推导型、错题复盘型、应用场景型、发散延伸型、记忆巩固型"],
  "open_questions": ["对话结束时仍未解决的疑问（没有则空数组）"],
  "knowledge_links": ["涉及的学科/领域标签（如：复分析、数理统计）"],
  "depth_score": 1到5的整数，评估追问深度（1=浅尝辄止，5=追根究底）
}`

func TestPslSummaryPromptTemplateMatchesTS(t *testing.T) {
	if pslSummaryPromptTemplate != pslSummaryPromptWantTS {
		t.Fatalf("prompt 模板与 TS 源不一致")
	}
}

func TestPslBuildSessionSummaryPrompt(t *testing.T) {
	long := strings.Repeat("长", 3005) // 超 3000 触发截断
	msgs := []pslSummaryMessage{
		{Role: "user", Content: "什么是留数定理？"},
		{Role: "assistant", Content: nil},        // 假值 → 空串
		{Role: float64(5), Content: float64(42)}, // 非字符串 role → 导师；内容按 JS 字面量
		{Role: "user", Content: long},            // 截断到 3000 rune
		{Content: map[string]any{"k": "v"}},      // 缺 role → 导师；对象取紧凑 JSON（TS 为 [object Object]，见交付说明）
	}
	got := pslBuildSessionSummaryPrompt(msgs)
	want := strings.Replace(pslSummaryPromptWantTS, "%s", strings.Join([]string{
		"学生：什么是留数定理？",
		"导师：",
		"导师：42",
		"学生：" + strings.Repeat("长", 3000),
		"导师：" + `{"k":"v"}`,
	}, "\n"), 1)
	if got != want {
		t.Fatalf("prompt 不符\n got: %.200q\nwant: %.200q", got, want)
	}
}

func TestPslStringify(t *testing.T) {
	tests := []struct {
		in   any
		want string
	}{
		{nil, ""},
		{"abc", "abc"},
		{true, "true"},
		{false, "false"},
		{float64(42), "42"},
		{float64(3.5), "3.5"},
		{[]any{float64(1), "x"}, `[1,"x"]`},
	}
	for _, tt := range tests {
		if got := pslStringify(tt.in); got != tt.want {
			t.Fatalf("pslStringify(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestPslTruncateRunes(t *testing.T) {
	tests := []struct {
		in   string
		n    int
		want string
	}{
		{"abcdef", 3, "abc"},
		{"abc", 5, "abc"},
		{"", 3, ""},
		{"中文五字", 3, "中文五"},
		{"中文五字", 0, ""},
		{"a中文", 2, "a中"},
	}
	for _, tt := range tests {
		if got := pslTruncateRunes(tt.in, tt.n); got != tt.want {
			t.Fatalf("pslTruncateRunes(%q,%d) = %q, want %q", tt.in, tt.n, got, tt.want)
		}
	}
}

func TestPslExtractJSONObject(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{`噪声 {"a":1} 尾巴`, `{"a":1}`, true},
		{"前缀 {\"a\":{\"b\":2}} 后缀", `{"a":{"b":2}}`, true}, // 贪婪：首个 { 到最后 }
		{"没有大括号", "", false},
		{"只有 { 左半", "", false},
		{"只有 } 右半", "", false},
		{"}{", "", false}, // '{' 在 '}' 之后
	}
	for _, tt := range tests {
		got, ok := pslExtractJSONObject(tt.in)
		if ok != tt.ok || (ok && got != tt.want) {
			t.Fatalf("pslExtractJSONObject(%q) = (%q,%v), want (%q,%v)", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}

func TestPslDepthScore(t *testing.T) {
	tests := []struct {
		in   any
		want int
	}{
		{float64(1), 1}, {float64(3), 3}, {float64(5), 5},
		{float64(0), 1},   // parseInt(0)||1：0 为假值 → 1
		{float64(9), 5},   // 上夹
		{float64(-2), 1},  // 下夹
		{float64(3.7), 3}, // parseInt(3.7)=3
		{"4", 4},
		{"4 stars", 4},  // parseInt 前缀解析
		{"abc", 1},      // NaN → 1
		{nil, 1},        // undefined → 1
		{true, 1},       // String(true) 无数字 → 1
		{"0x1A", 1},     // JS 会按十六进制得 26→5；Go 复用的 parseJSInt 得 0（假值）→ 1，已知差异（notes.go parseJSInt 注释）
		{[]any{"3"}, 1}, // 数组非字符串/数字 → 1
	}
	for _, tt := range tests {
		if got := pslDepthScore(tt.in); got != tt.want {
			t.Fatalf("pslDepthScore(%v) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestPslStringArray(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want []string
	}{
		{"非数组归空", "x", []string{}},
		{"null 归空", nil, []string{}},
		{"对象归空", map[string]any{"a": 1}, []string{}},
		{"空数组", []any{}, []string{}},
		{
			"超过 5 个截断",
			[]any{"1", "2", "3", "4", "5", "6", "7"},
			[]string{"1", "2", "3", "4", "5"},
		},
		{
			"元素字符串化 + 各截 200",
			[]any{float64(12), true, strings.Repeat("字", 205)},
			[]string{"12", "true", strings.Repeat("字", 200)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pslStringArray(tt.in)
			if got == nil {
				t.Fatalf("got nil，必须为非 nil 空切片（JSON 编码为 []）")
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestPslBuildSummaryPayload(t *testing.T) {
	parsed := map[string]any{
		"question":          "核心问题",
		"summary":           strings.Repeat("答", 4005),
		"mastered":          []any{"概念A", "概念B"},
		"confusions":        nil, // 非数组 → []
		"question_patterns": []any{"概念辨析型"},
		"open_questions":    []any{float64(1), "x", "y", "z", "w", "v"}, // 第 6 个被裁
		"knowledge_links":   []any{"复分析"},
		"depth_score":       "4",
	}
	got := pslBuildSummaryPayload("u1", "s1", parsed)
	want := pslSummaryPayload{
		UserID: "u1", ChatSessionID: "s1",
		Question:         "核心问题",
		Answer:           strings.Repeat("答", 4000),
		Mastered:         []string{"概念A", "概念B"},
		Confusions:       []string{},
		QuestionPatterns: []string{"概念辨析型"},
		OpenQuestions:    []string{"1", "x", "y", "z", "w"},
		KnowledgeLinks:   []string{"复分析"},
		DepthScore:       4,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	// 载荷 JSON 键与 TS 字段一一对应（problem-solving-logs.ts:63-74）
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, key := range []string{
		"user_id", "chat_session_id", "question", "answer", "mastered",
		"confusions", "question_patterns", "open_questions", "knowledge_links",
		"depth_score",
	} {
		if _, ok := m[key]; !ok {
			t.Fatalf("载荷缺少字段 %q: %s", key, b)
		}
	}
	if string(b) == "null" || strings.Contains(string(b), ":null") {
		t.Fatalf("载荷出现 null（TS 侧数组列始终是 []）: %s", b)
	}
}

func TestPslDecodeSummaryMessages(t *testing.T) {
	raw := []any{
		map[string]any{"role": "user", "content": "问题"},
		map[string]any{"role": "assistant", "content": nil},
		"裸字符串", // TS：属性访问得 undefined → 角色'导师'/内容''；Go 同形处理
	}
	got := pslDecodeSummaryMessages(raw)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	if s, _ := got[0].Role.(string); s != "user" || got[0].Content != "问题" {
		t.Fatalf("got[0] = %+v", got[0])
	}
	if got[1].Content != nil {
		t.Fatalf("got[1].Content = %v, want nil", got[1].Content)
	}
	if got[2].Role != nil || got[2].Content != nil {
		t.Fatalf("got[2] = %+v, want 零值", got[2])
	}
	if pslDecodeSummaryMessages("not-array") != nil {
		t.Fatalf("非数组应返回 nil")
	}
}

// ── maybeSingle 客户端解包（reflections.ts:32-34 的等价行为）──────────

func TestRecordsMaybeSingleUnwrap(t *testing.T) {
	tests := []struct {
		name  string
		rows  json.RawMessage
		row   json.RawMessage
		found bool
	}{
		{"0 行 → 未找到", json.RawMessage(`[]`), nil, false},
		{"1 行 → 该行", json.RawMessage(`[{"id":7}]`), json.RawMessage(`{"id":7}`), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row, found := recordsMaybeSingleUnwrap(tt.rows)
			if found != tt.found || (found && !reflect.DeepEqual(row, tt.row)) {
				t.Fatalf("got (%s,%v), want (%s,%v)", row, found, tt.row, tt.found)
			}
		})
	}
}

// ── /stats 的参数与分组（problem-solving-logs.ts:178-209）────────────

func TestRecStatsDays(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 30},    // 缺省
		{"30", 30},  // parseInt||30
		{"abc", 30}, // NaN → 30
		{"0", 30},   // parseInt=0 为 JS 假值 → 30
		{"7", 7},
		{"12px", 12}, // 前缀解析
		{"-5", -5},   // 负数透传（PostgREST 报错 → 500，同 TS）
		{"3.9", 3},   // parseInt 截断
	}
	for _, tt := range tests {
		if got := recStatsDays(tt.in); got != tt.want {
			t.Fatalf("recStatsDays(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestRecDailyStats(t *testing.T) {
	createds := []string{
		"2026-10-15T02:00:00+00:00", // UTC 当天
		"2026-10-15T23:30:00Z",      // UTC 当天
		"2026-10-15T18:00:00-05:00", // UTC = 10-15 23:00 → 当天（TS 按 UTC 取日期）
		"2026-10-16T01:00:00.500+00:00",
		"2026-10-14T10:00:00+00:00",
	}
	got, err := recDailyStats(createds)
	if err != nil {
		t.Fatalf("recDailyStats: %v", err)
	}
	want := map[string]int{
		"2026-10-14": 1,
		"2026-10-15": 3,
		"2026-10-16": 1,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if _, err := recDailyStats([]string{"garbage"}); err == nil ||
		err.Error() != "Invalid time value" {
		t.Fatalf("err = %v, want TS 同款 'Invalid time value'", err)
	}
}

func TestParseJSDate(t *testing.T) {
	tests := []struct {
		in      string
		wantUTC string // UTC 格式化结果
	}{
		{"2026-10-15T12:34:56.789+00:00", "2026-10-15T12:34:56.789"},
		{"2026-10-15T12:34:56Z", "2026-10-15T12:34:56"},
		{"2026-10-15", "2026-10-15T00:00:00"}, // date-only 按 UTC（JS 语义）
		{"2026-10-15T18:00:00-05:00", "2026-10-15T23:00:00"},
	}
	for _, tt := range tests {
		got, err := parseJSDate(tt.in)
		if err != nil {
			t.Fatalf("parseJSDate(%q): %v", tt.in, err)
		}
		if s := got.UTC().Format("2006-01-02T15:04:05.999"); s != tt.wantUTC {
			t.Fatalf("parseJSDate(%q) UTC = %q, want %q", tt.in, s, tt.wantUTC)
		}
	}
	if _, err := parseJSDate("not-a-date"); err == nil {
		t.Fatalf("垃圾输入应报错")
	}
}

// ── control-center 的纯逻辑（control-center.ts:44-107）────────────────

func TestRecPerTableLimit(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 50},
		{"abc", 50},
		{"0", 50}, // JS: parseInt=0 假值 → 50
		{"50", 50},
		{"300", 300},
		{"1000", 500}, // Math.min(..., 500)
		{"-5", -5},    // 负数透传 → PostgREST 报错（同 TS）
	}
	for _, tt := range tests {
		if got := recPerTableLimit(tt.in); got != tt.want {
			t.Fatalf("recPerTableLimit(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestRecRowsWithType(t *testing.T) {
	rows, err := recRowsWithType(
		json.RawMessage(`[{"id":1,"created_at":"2026-10-15T00:00:00Z"}]`), "study_note")
	if err != nil {
		t.Fatalf("recRowsWithType: %v", err)
	}
	if rows[0]["record_type"] != "study_note" {
		t.Fatalf("record_type = %v", rows[0]["record_type"])
	}
	empty, err := recRowsWithType(json.RawMessage(`[]`), "material")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("空结果应得非 nil 空切片, got %#v err=%v", empty, err)
	}
}

func TestRecSortByCreatedAtDesc(t *testing.T) {
	rows := []map[string]any{
		{"id": float64(1), "created_at": "2026-10-14T00:00:00Z"},
		{"id": float64(2), "created_at": "2026-10-16T00:00:00Z"},
		{"id": float64(3), "created_at": "2026-10-15T00:00:00Z"},
		{"id": float64(4), "created_at": "解析失败排最后"},
	}
	recSortByCreatedAtDesc(rows)
	got := []float64{rows[0]["id"].(float64), rows[1]["id"].(float64), rows[2]["id"].(float64), rows[3]["id"].(float64)}
	want := []float64{2, 3, 1, 4}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRecIDString(t *testing.T) {
	if got := recIDString("42"); got != "42" {
		t.Fatalf("字符串原样: %q", got)
	}
	if got := recIDString(float64(42)); got != "42" {
		t.Fatalf("数字按 JS 字面量: %q", got)
	}
	if got := recIDString(float64(4.5)); got != "4.5" {
		t.Fatalf("小数: %q", got)
	}
}

// ── chat-sessions 兜底常量（chat-sessions.ts:9/29/70）────────────────

func TestChatTempUserIDFallback(t *testing.T) {
	if chatTempUserID != "temp_user" {
		t.Fatalf("chatTempUserID = %q, want temp_user", chatTempUserID)
	}
}

// ── 请求体解码（express.json 空 body → {} 的等价行为）────────────────

func TestRecordsDecodeBody(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		want    map[string]any
		wantBad bool
	}{
		{"空 body 等价 {}", "", map[string]any{}, false},
		{"纯空白等价 {}", "   \n ", map[string]any{}, false},
		{"对象", `{"a":1}`, map[string]any{"a": float64(1)}, false},
		{"数组按空对象（TS 解构 undefined）", `[1,2]`, map[string]any{}, false},
		{"null 按空对象（TS 会 500，已知取舍）", `null`, map[string]any{}, false},
		{"畸形 JSON 400", `{bad`, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/x", strings.NewReader(tt.body))
			got, ok := recordsDecodeBody(rec, req)
			if tt.wantBad {
				if ok || rec.Code != http.StatusBadRequest {
					t.Fatalf("ok=%v code=%d, want 400", ok, rec.Code)
				}
				return
			}
			if !ok || !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("ok=%v got %#v, want %#v", ok, got, tt.want)
			}
		})
	}
}

// TestChatSessionsCreateEmptyBody 验证空 body 下 chat-sessions 创建与 TS
// 同走默认值路径：express.json 空 body → {} → title||'新对话'。
// 仅断言解码层（写库需要真实 Supabase，不在此覆盖）。
func TestChatSessionsCreateEmptyBody(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat-sessions", strings.NewReader(""))
	body, ok := recordsDecodeBody(rec, req)
	if !ok {
		t.Fatalf("空 body 应按 {} 解码，got code=%d", rec.Code)
	}
	if got := jsOr(body["title"], "新对话"); got != "新对话" {
		t.Fatalf("title 默认值 = %v, want 新对话", got)
	}
	_ = time.Time{} // 保持 time 引用（parseJSDate 系列依赖）
}
