package api

// ai 组纯逻辑函数的表驱动测试（不触网络 / 数据库 / 文件）。
// 契约来源：server/src/routes/ai.ts 对应行号见各用例注释。

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// ── cleanCitationSnippet（ai.ts:202-210）─────────────────────────────

func TestCleanCitationSnippet(t *testing.T) {
	tests := []struct {
		name string
		in   string // 空串表示入参为 nil
		want string // 空串表示期望返回 nil（键缺省）
	}{
		{"nil 入参返回 nil", "", ""},
		{"清洗后为空返回 nil", "   ", ""},
		{"只去掉分页占位符", "留数定理 -- 1 of 67 -- 的应用", "留数定理 的应用"},
		{"占位符大小写不敏感", "A -- 2 OF 9 -- B", "A B"},
		{"占位符容忍内部空白", "A --  12  of  67  -- B", "A B"},
		{"去掉 ASCII 省略号", "前文...后文", "前文后文"},
		{"去掉中文省略号", "前文……后文", "前文后文"},
		{"压缩空白为单空格", "第一 行\n第二\t行", "第一 行 第二 行"},
		{"首尾 trim", "  片段  ", "片段"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var in *string
			if tt.in != "" {
				in = &tt.in
			}
			got := cleanCitationSnippet(in)
			if tt.want == "" {
				if got != nil {
					t.Fatalf("got %q, want nil", *got)
				}
				return
			}
			if got == nil || *got != tt.want {
				t.Fatalf("got %v, want %q", got, tt.want)
			}
		})
	}
}

// ── parseReflectionSections（ai.ts:1229-1262）────────────────────────

func TestParseReflectionSections(t *testing.T) {
	t.Run("完整四段", func(t *testing.T) {
		text := "## 学习行为\n本周学习了复变函数。\n\n## 攻克问题\n解决了留数计算。\n\n## 思维模式\n擅长类比。\n\n## 学习建议\n多做习题。"
		got := parseReflectionSections(text)
		if got.learningBehavior != "本周学习了复变函数。" || got.challengeReport != "解决了留数计算。" ||
			got.thinkingPattern != "擅长类比。" || got.suggestion != "多做习题。" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("缺段则该字段为空", func(t *testing.T) {
		text := "## 学习行为\n内容A\n\n## 学习建议\n内容D"
		got := parseReflectionSections(text)
		if got.learningBehavior != "内容A" || got.suggestion != "内容D" {
			t.Fatalf("got %+v", got)
		}
		if got.challengeReport != "" || got.thinkingPattern != "" {
			t.Fatalf("缺失段应为空，got %+v", got)
		}
	})
	t.Run("内容裁掉首尾空白", func(t *testing.T) {
		text := "## 学习行为\n\n\n  内容B  \n\n## 学习建议\n内容D\n\n\n"
		got := parseReflectionSections(text)
		if got.learningBehavior != "内容B" {
			t.Fatalf("learningBehavior = %q", got.learningBehavior)
		}
	})
	t.Run("纯空白段会被贪婪的 \\s* 并入标题、内容顺延（TS 同此怪癖）", func(t *testing.T) {
		// TS 正则 `##\s+标题\s*\n` 的 \s* 跨行贪婪：第二个「学习行为」的
		// 空白内容被吞进标题，内容直接从下一个 "## 学习建议" 开始并覆盖赋值
		text := "## 学习行为\n内容A\n\n## 学习行为\n   \n\n## 学习建议\n内容D"
		got := parseReflectionSections(text)
		if got.learningBehavior != "## 学习建议\n内容D" {
			t.Fatalf("learningBehavior = %q, want %q（对齐 TS 语义）",
				got.learningBehavior, "## 学习建议\n内容D")
		}
		if got.suggestion != "" {
			t.Fatalf("suggestion = %q, want 空（被上一段吞掉）", got.suggestion)
		}
	})
	t.Run("段内容为空串时不赋值", func(t *testing.T) {
		// 头部后紧跟文本结束：内容为空 → 不写入
		text := "## 学习行为\n"
		got := parseReflectionSections(text)
		if got.learningBehavior != "" {
			t.Fatalf("got %q, want 空", got.learningBehavior)
		}
	})
	t.Run("重复标题后者覆盖", func(t *testing.T) {
		text := "## 学习行为\n旧\n\n## 学习行为\n新\n\n## 学习建议\n内容D"
		got := parseReflectionSections(text)
		if got.learningBehavior != "新" {
			t.Fatalf("learningBehavior = %q, want 新", got.learningBehavior)
		}
	})
	t.Run("## 后无空白不算标题", func(t *testing.T) {
		text := "##学习行为\n内容A"
		got := parseReflectionSections(text)
		if got.learningBehavior != "" {
			t.Fatalf("无空白分隔不应匹配，got %q", got.learningBehavior)
		}
	})
	t.Run("非标题行内的 ## 不切断内容", func(t *testing.T) {
		text := "## 学习行为\n提到 ### 子标题 与\n##正文中缀\n继续\n\n## 学习建议\n内容D"
		got := parseReflectionSections(text)
		want := "提到 ### 子标题 与\n##正文中缀\n继续"
		if got.learningBehavior != want {
			t.Fatalf("learningBehavior = %q, want %q", got.learningBehavior, want)
		}
	})
}

// ── extractMentions / filterCitationsByMentions（ai.ts:443-470）─────

func TestExtractMentions(t *testing.T) {
	tests := []struct {
		name   string
		answer string
		want   []string
	}{
		{"全角冒号", "根据【来源：复变函数讲义】可知", []string{"复变函数讲义"}},
		{"半角冒号带空格", "根据【来源: 留数定理】可知", []string{"留数定理"}},
		{"多个标注", "【来源：A】然后【来源：B】", []string{"A", "B"}},
		{"无标注", "没有任何来源标记", nil},
		{"缺冒号不匹配", "【来源复变函数讲义】", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractMentions(tt.answer)
			if len(got) != len(tt.want) {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("got %q, want %q", got, tt.want)
				}
			}
		})
	}
}

func TestFilterCitationsByMentions(t *testing.T) {
	mk := func(typ string, id int, title string) citation {
		return citation{Type: typ, SourceID: id, SourceType: typ, Title: title}
	}
	base := []citation{
		mk("material", 1, "复变函数讲义"),
		mk("study_note", 2, "留数定理笔记"),
		mk("material", 3, "无关资料"),
		{Type: "image", SourceID: "uploaded_image", SourceType: "image", Title: "上传的图片"},
	}

	t.Run("命中保留 + 图片置首 + 去重", func(t *testing.T) {
		// 两条标注都指向 id=1（重复），另一条指向 id=2
		got := filterCitationsByMentions([]string{"复变函数讲义", "讲义", "留数定理笔记"}, base)
		if got == nil {
			t.Fatal("got nil, want filtered slice")
		}
		if len(got) != 3 {
			t.Fatalf("len = %d, want 3（图片 + 去重后的两个来源）: %v", len(got), got)
		}
		if got[0].Type != "image" {
			t.Fatalf("首条应为图片，got %v", got[0])
		}
		if got[1].SourceID != 1 || got[2].SourceID != 2 {
			t.Fatalf("顺序/去重错误: %v", got)
		}
	})
	t.Run("无匹配返回 nil（回退 image-only）", func(t *testing.T) {
		if got := filterCitationsByMentions([]string{"量子力学"}, base); got != nil {
			t.Fatalf("got %v, want nil", got)
		}
	})
	t.Run("mention 包含名称也算命中（互相包含）", func(t *testing.T) {
		got := filterCitationsByMentions([]string{"详见《复变函数讲义》第 3 章"}, base)
		if got == nil || len(got) != 2 || got[1].SourceID != 1 {
			t.Fatalf("got %v, want [image, material#1]", got)
		}
	})
	t.Run("名称含空白仍可匹配", func(t *testing.T) {
		got := filterCitationsByMentions([]string{"复 变 函 数 讲 义"}, base)
		if got == nil || len(got) != 2 || got[1].SourceID != 1 {
			t.Fatalf("got %v, want [image, material#1]", got)
		}
	})
}

// ── citation JSON 形状（键存在性三态，RN 客户端契约）────────────────

func TestCitationJSONShape(t *testing.T) {
	t.Run("检索结果的引用：pageNumber 显式 null、tags 空数组", func(t *testing.T) {
		empty := []string{}
		c := citation{
			Type: "study_note", SourceID: 7, SourceType: "study_note", Title: "纪要7",
			Papercore: "一句话概述", Tags: slicePtr(empty),
			PageNumber: jsOr(nil, jsonNull), // TS：r.pageNumber || null
		}
		b, _ := json.Marshal(c)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if _, ok := m["pageNumber"]; !ok {
			t.Fatal("pageNumber 键必须存在（TS 显式 null）")
		}
		if m["pageNumber"] != nil {
			t.Fatalf("pageNumber = %v, want null", m["pageNumber"])
		}
		if arr, ok := m["tags"].([]any); !ok || len(arr) != 0 {
			t.Fatalf("tags = %v, want []（TS 的 `m.tags || []` 保留空数组键）", m["tags"])
		}
		for _, absent := range []string{"snippet", "fileName", "draftId", "label", "fileUrl"} {
			if _, ok := m[absent]; ok {
				t.Fatalf("%s 键不应存在（TS undefined 被 JSON.stringify 丢弃）", absent)
			}
		}
	})
	t.Run("nodeIds 补发的引用：只有基础键 + label", func(t *testing.T) {
		c := citation{
			Type: "knowledge_node", SourceID: 3, SourceType: "knowledge_node",
			Title: "知识节点 3", Label: strPtr("知识节点 3"),
		}
		b, _ := json.Marshal(c)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		for _, want := range []string{"type", "sourceId", "sourceType", "title", "label"} {
			if _, ok := m[want]; !ok {
				t.Fatalf("缺键 %s: %s", want, b)
			}
		}
		if len(m) != 5 {
			t.Fatalf("键数 = %d, want 5: %s", len(m), b)
		}
	})
	t.Run("papercore 为 null（DB 空值）时键存在值为 null", func(t *testing.T) {
		var nilPtr *string
		c := citation{
			Type: "knowledge_node", SourceID: 1, SourceType: "knowledge_node",
			Title: "x", Papercore: nilPtr, // Layer 1 节点的 papercore 可为 null
		}
		b, _ := json.Marshal(c)
		if !strings.Contains(string(b), `"papercore":null`) {
			t.Fatalf("papercore 应为 null: %s", b)
		}
	})
	t.Run("页码数字正常输出", func(t *testing.T) {
		c := citation{Type: "material", SourceID: 2, SourceType: "material",
			Title: "x", PageNumber: 12}
		b, _ := json.Marshal(c)
		if !strings.Contains(string(b), `"pageNumber":12`) {
			t.Fatalf("pageNumber 应为 12: %s", b)
		}
	})
}

// ── suggest-relations 的 LLM JSON 解析（ai.ts:695-708）──────────────

func TestParseClassified(t *testing.T) {
	t.Run("正常数组", func(t *testing.T) {
		got, ok := parseClassified(`[{"nodeId":1,"relation_type":"prerequisite"},{"nodeId":2,"relation_type":"parent"}]`)
		if !ok || len(got) != 2 || got[0].nodeID != 1 || got[0].relationType != "prerequisite" ||
			got[1].nodeID != 2 || got[1].relationType != "parent" {
			t.Fatalf("got %v ok=%v", got, ok)
		}
	})
	t.Run("thinking 前后缀包裹时取首 [ 到末 ]", func(t *testing.T) {
		got, ok := parseClassified("思考过程……\n[{\"nodeId\":5,\"relation_type\":\"related\"}]\n以上。")
		if !ok || len(got) != 1 || got[0].nodeID != 5 {
			t.Fatalf("got %v ok=%v", got, ok)
		}
	})
	t.Run("无数组返回 false", func(t *testing.T) {
		if _, ok := parseClassified("抱歉我不会"); ok {
			t.Fatal("无 [ ] 应返回 false")
		}
	})
	t.Run("坏 JSON 返回 false", func(t *testing.T) {
		if _, ok := parseClassified("[{nodeId:1}]"); ok {
			t.Fatal("非严格 JSON 应返回 false")
		}
	})
	t.Run("null/字符串/非整数 nodeId 被跳过（等价 TS 匹配不上数字键）", func(t *testing.T) {
		got, ok := parseClassified(`[{"nodeId":null,"relation_type":"related"},{"nodeId":"5","relation_type":"related"},{"nodeId":5.5,"relation_type":"related"},{"nodeId":9,"relation_type":"parent"}]`)
		if !ok || len(got) != 1 || got[0].nodeID != 9 {
			t.Fatalf("got %v ok=%v, want 仅 nodeId=9", got, ok)
		}
	})
}

// ── 反思 period 解析（ai.ts:1120/1190-1196/1293）────────────────────

func TestParsePeriodDays(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"3days", 3},
		{"7days", 7},
		{"30days", 30},
		{"week", 7},      // 无数字 → NaN || 7
		{"", 7},          // 空串 → 7
		{"3days30", 330}, // TS 会拼接出 "330"
	}
	for _, tt := range tests {
		if got := parsePeriodDays(tt.in); got != tt.want {
			t.Fatalf("parsePeriodDays(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestPeriodLabel(t *testing.T) {
	// 注意 TS 的判定顺序（ai.ts:1190-1196）：includes('3') 在 includes('30')
	// 之前，"30days" 含 '3' → 命中「近三天」。这是 TS 原版怪癖，Go 侧如实保留。
	tests := []struct {
		in   string
		want string
	}{
		{"3days", "近三天"},
		{"30days", "近三天"},
		{"7days", "近一周"},
		{"", "近期"},
		{"13days", "近三天"}, // includes('3') 字面判定
	}
	for _, tt := range tests {
		if got := periodLabel(tt.in); got != tt.want {
			t.Fatalf("periodLabel(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestReflectionSince(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	got := reflectionSince("3days", now)
	want := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("reflectionSince = %v, want %v", got, want)
	}
}

// ── /suggest 文件内容拼装（ai.ts:584-588）────────────────────────────

func TestBuildSuggestFileText(t *testing.T) {
	p1 := 1
	var pN *int // page_number 为 null
	t1, t2 := "第一页文本", ""
	rows := []suggestFcRow{
		{ExtractedText: &t1, PageNumber: &p1},
		{ExtractedText: &t2, PageNumber: pN}, // page_number 为 null → '?'
	}
	got := buildSuggestFileText(rows)
	want := "[第1页] 第一页文本\n\n[第?页] "
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// ── findPageForSnippet 的页评分（ai.ts:1434-1447）────────────────────

func TestScoreBestPage(t *testing.T) {
	pages := []string{
		"第一章 绪论 介绍背景",  // 与片段重叠低
		"第二章 留数定理及其应用", // 与片段重叠高
		"第三章 数值积分",     // 无重叠
	}
	if got := scoreBestPage(pages, "留数定理的应用场景"); got != 2 {
		t.Fatalf("best page = %d, want 2", got)
	}
	if got := scoreBestPage(pages[:1], "完全不相关的片段"); got != 1 {
		t.Fatalf("无重叠时应保持第 1 页, got %d", got)
	}
}

// ── refine-note 引用同步（ai.ts:1782-1790）───────────────────────────

func TestSyncRefineCitations(t *testing.T) {
	raws := []json.RawMessage{
		json.RawMessage(`{"index":1,"sourceId":"a","sourceType":"study_note","fileName":"A"}`),
		json.RawMessage(`{"index":2,"sourceId":"b","sourceType":"material","fileName":"B"}`),
		json.RawMessage(`{"sourceId":"c","sourceType":"material","fileName":"无 index"}`),
	}
	got := syncRefineCitations("正文 [来源:1] 与 [来源:3]", raws)
	if len(got) != 1 || !strings.Contains(string(got[0]), `"index":1`) {
		t.Fatalf("got %s, want 仅保留 index=1", got)
	}
	if g2 := syncRefineCitations("没有引用了", raws); len(g2) != 0 {
		t.Fatalf("无标记应全滤, got %s", g2)
	}
}

// ── round2（ai.ts:726/740 的 Math.round(x*100)/100）─────────────────

func TestRound2(t *testing.T) {
	tests := []struct {
		in   float64
		want float64
	}{
		{0.56789, 0.57},
		{0.5, 0.5},
		{1.005, 1.0}, // JS Math.round(100.49999...) = 100，二进制表示下 1.005*100 < 100.5
		{0.999, 1},
	}
	for _, tt := range tests {
		if got := round2(tt.in); got != tt.want {
			t.Fatalf("round2(%v) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

// ── JS 空白边界（aiTrimJS）──────────────────────────────────────────

func TestAiTrimJS(t *testing.T) {
	if got := aiTrimJS("\uFEFF  片段 \n\t"); got != "片段" {
		t.Fatalf("got %q", got)
	}
	// \u0085（NEL）不是 JS trim 的空白
	if got := aiTrimJS("\u0085片段"); got != "\u0085片段" {
		t.Fatalf("NEL 不应被剥离, got %q", got)
	}
}
