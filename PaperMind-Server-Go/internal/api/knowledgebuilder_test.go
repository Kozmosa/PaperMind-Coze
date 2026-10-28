package api

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// 测试夹具：PostgREST 错误 / 普通网络错误各一。
var (
	postgrestErrorForTest = &db.PostgrestError{Code: "42703", Message: "column missing"}
	errPlainForTest       = errors.New("dial tcp: connection refused")
)

// ── 知识构建组纯逻辑的表驱动单测（不触网 / 不碰 DB / 不上传文件）──
// 对照源：server/src/routes/knowledge-builder.ts 的对应行号见各函数注释。

func TestKbUTF16Len(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"数学", 2},                         // BMP 内 1 字符 = 1 码元
		{"a😀b", 4},                        // 增补平面字符占 2 码元（JS length=4）
		{strings.Repeat("x", 2000), 2000}, // stripTOC 的长度门槛语义
	}
	for _, c := range cases {
		if got := kbUTF16Len(c.in); got != c.want {
			t.Errorf("kbUTF16Len(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestKbJSSlice(t *testing.T) {
	cases := []struct {
		in          string
		start, end  int
		want        string
		description string
	}{
		{"hello world", 0, 5, "hello", "基本切片"},
		{"hello world", 6, 999, "world", "end 越界钳制"},
		{"hello", -4, 5, "ello", "负 start 从末尾数"},
		{"hello", -500, 2, "he", "负 start 越界钳 0"},
		{"hello", 3, 1, "", "start>=end 空串"},
		{"数学分析", 0, 2, "数学", "中文按码元切"},
		{"abcdef", 2, -2, "cd", "负 end"},
	}
	for _, c := range cases {
		if got := kbJSSlice(c.in, c.start, c.end); got != c.want {
			t.Errorf("%s: kbJSSlice(%q, %d, %d) = %q, want %q",
				c.description, c.in, c.start, c.end, got, c.want)
		}
	}
}

func TestKbStripTOC(t *testing.T) {
	// 页码标记块："-- 2 of 12 --" 风格（markerRegex）
	page := func(n, total int, body string) string {
		return body + "\n-- " + strconv.Itoa(n) + " of " + strconv.Itoa(total) + " --\n"
	}
	// 每页正文约 80 字，保证第 3 个标记后仍有 >100 字（skipTo < total-100）
	build := func(total int) string {
		var sb strings.Builder
		for i := 1; i <= total; i++ {
			body := "目录条目......." + strconv.Itoa(10+i) + strings.Repeat("页", 60)
			sb.WriteString(page(i, total, body))
		}
		return sb.String()
	}

	cases := []struct {
		name string
		in   string
		want string
	}{
		{"短文本原样返回", "短文本", "短文本"},
		{"低点密度原样返回", strings.Repeat("正常内容无点", 300), strings.Repeat("正常内容无点", 300)},
	}
	for _, c := range cases {
		if got := kbStripTOC(c.in); got != c.want {
			t.Errorf("%s: kbStripTOC 未按预期返回原文本", c.name)
		}
	}

	// 高点密度 + ≥3 个页码标记：跳到第 3 个标记之后
	toc := strings.Repeat(".", 1500) + build(6) // 前置 1500 个点抬高点密度（>5%）
	got := kbStripTOC(toc)
	if !strings.Contains(got, "目录条目.......14") {
		t.Errorf("stripTOC 应跳过前 3 页（第 4 页正文应保留），got 前 80 字: %q", kbJSSlice(got, 0, 80))
	}
	if strings.Contains(got, "-- 1 of 6 --") || strings.Contains(got, "-- 2 of 6 --") {
		t.Errorf("stripTOC 后不应再含前两页页码标记")
	}

	// 高点密度但标记不足 3 个 + 超长 → 跳前 3000 字 fallback
	noMarkers := strings.Repeat("目录......条目", 500) // 5000 字（>4000 才走 fallback），无页码标记
	got = kbStripTOC(noMarkers)
	if kbUTF16Len(got) != kbUTF16Len(noMarkers)-3000 {
		t.Errorf("fallback 应跳过前 3000 字，剩余 %d，want %d",
			kbUTF16Len(got), kbUTF16Len(noMarkers)-3000)
	}
}

func TestKbCharOverlapRatio(t *testing.T) {
	// 语义：去空白后字符「集合」的交集 / 较小集合大小
	cases := []struct {
		a, b string
		want float64
	}{
		{"", "abc", 0},
		{"abc", "", 0},
		{"复分析", "复分析", 1},           // 同集合
		{"复变函数", "复分析", 1.0 / 3.0},  // a={复,变,函,数} b={复,分,析} shared={复} → 1/min(4,3)
		{"对偶理论", "对偶定理", 3.0 / 4.0}, // shared={对,偶,理}=3, min=4
		{"线性 规划", "线性规划", 1},        // 空白剔除后集合一致
		{"ABCDE", "abcde", 0},       // 大小写敏感
	}
	for _, c := range cases {
		got := kbCharOverlapRatio(c.a, c.b)
		if diff := got - c.want; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("kbCharOverlapRatio(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestKbIsGarbageL3Tag(t *testing.T) {
	cases := []struct {
		in   string
		want bool
		why  string
	}{
		{"对偶理论", false, "正常章节名"},
		{"单纯形法", false, "普通名词"},
		{"什么是单纯形法", true, "疑问词开头"},
		{"为什么对偶定理成立", true, "为什么开头"},
		{"动态规划是什么呢", true, "呢结尾"},
		{"这个方法对吗", true, "吗结尾"},
		{"Bi_ORC5(week10 2).pdf", true, "文件扩展名残留"},
		{"这是一个特别特别长的章节标签超过二十个字符", true, "超 20 字"},
		{"排队论？", true, "含问号（半角）"},
		{"排队论?", true, "含问号（全角）"},
	}
	for _, c := range cases {
		if got := kbIsGarbageL3Tag(c.in); got != c.want {
			t.Errorf("%s: kbIsGarbageL3Tag(%q) = %v, want %v", c.why, c.in, got, c.want)
		}
	}
}

func TestKbFilterL3s(t *testing.T) {
	// 语义：剔 INVALID 成员、"无法/未"开头、与父级 L2 同名、垃圾标签
	l2 := "运筹学"
	finalL3s := []string{"对偶理论", "无", "无法识别", "未知领域X", "未来章节", "运筹学", "什么是单纯形法", "排队论"}
	got := kbFilterL3s(finalL3s, l2)
	want := []string{"对偶理论", "排队论"}
	if len(got) != len(want) {
		t.Fatalf("kbFilterL3s = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("kbFilterL3s[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestKbBuildLogicalPaths(t *testing.T) {
	cases := []struct {
		name string
		l1   string
		l2   string
		kps  []string
		want []string
	}{
		{"完整三层", "数学", "运筹学", []string{"对偶理论", "排队论"},
			[]string{"/数学/运筹学/对偶理论/", "/数学/运筹学/排队论/"}},
		{"两层无 L3", "数学", "运筹学", nil, []string{"/数学/运筹学/"}},
		{"仅 L1", "数学", "", nil, []string{"/数学/"}},
		{"全空", "", "", []string{"x"}, []string{"/未分类/"}},
		{"L1 空 L2 非空（路径仍为未分类）", "", "运筹学", nil, []string{"/未分类/"}},
	}
	for _, c := range cases {
		got := kbBuildLogicalPaths(c.l1, c.l2, c.kps)
		if len(got) != len(c.want) {
			t.Fatalf("%s: got %v want %v", c.name, got, c.want)
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Errorf("%s: [%d] = %q, want %q", c.name, i, got[i], c.want[i])
			}
		}
	}
}

func TestKbParseLogicalPathArray(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		want   []string
		wantOK bool
	}{
		{"普通数组", `["/数学/分析/","/数学/代数/"]`, []string{"/数学/分析/", "/数学/代数/"}, true},
		{"空数组", `[]`, []string{}, true},
		{"双嵌套（issue #18）", `["[\"/数学/复分析/\"]"]`, []string{"/数学/复分析/"}, true},
		{"三层嵌套", `["[\"[\\\"/数学/\\\"]\"]"]`, []string{"/数学/"}, true},
		{"非 JSON", "普通字符串", nil, false},
		{"JSON 字符串非数组", `"hello"`, nil, false},
		{"JSON 对象", `{"a":1}`, nil, false},
		{"以 [ 开头但非 JSON 的元素", `["[重点] 第一章"]`, []string{"[重点] 第一章"}, true},
		{"元素 trim + 假值剔除", `[" /a/ ", ""]`, []string{"/a/"}, true},
	}
	for _, c := range cases {
		got, ok := kbParseLogicalPathArray(c.in)
		if ok != c.wantOK {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.wantOK)
			continue
		}
		if !c.wantOK {
			continue
		}
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
			continue
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Errorf("%s: [%d] = %q, want %q", c.name, i, got[i], c.want[i])
			}
		}
	}
}

func TestKbUserSetLogicalPath(t *testing.T) {
	cases := []struct {
		name string
		rec  map[string]any
		want string
	}{
		{"缺失", map[string]any{}, ""},
		{"空串", map[string]any{"logical_path": ""}, ""},
		{"纯空白", map[string]any{"logical_path": "   "}, ""},
		{"未分类", map[string]any{"logical_path": `["/未分类/"]`}, ""},
		{"包含未分类字样", map[string]any{"logical_path": `["/数学/未分类笔记/"]`}, ""},
		{"根路径", map[string]any{"logical_path": `["/"]`}, ""},
		{"正常路径", map[string]any{"logical_path": `["/数学/分析/"]`}, `["/数学/分析/"]`},
		{"双嵌套归一化", map[string]any{"logical_path": `["[\"/数学/复分析/\"]"]`}, `["/数学/复分析/"]`},
		{"非 JSON", map[string]any{"logical_path": "/数学/"}, ""},
		{"空数组", map[string]any{"logical_path": "[]"}, ""},
	}
	for _, c := range cases {
		if got := kbUserSetLogicalPath(c.rec); got != c.want {
			t.Errorf("%s: kbUserSetLogicalPath = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestKbBuildDegradedPapercore(t *testing.T) {
	cases := []struct {
		name         string
		fileName     string
		folderName   string
		wantContains string
		wantNoExt    bool
	}{
		{"文件名去扩展名+分隔符", "Bi_ORC5(week10).pdf", "",
			"Bi ORC5(week10)", true},
		{"文件夹兜底", "", "高等数学课件", "高等数学课件", true},
		{"全空", "", "", "", false},
	}
	for _, c := range cases {
		got := kbBuildDegradedPapercore(c.fileName, c.folderName)
		if c.fileName == "" && c.folderName == "" {
			if got != "该文档以公式/图表为主，核心主题未识别，建议手动补充摘要。" {
				t.Errorf("%s: 全空应返回固定文案，got %q", c.name, got)
			}
			continue
		}
		if !strings.Contains(got, c.wantContains) {
			t.Errorf("%s: %q 应包含 %q", c.name, got, c.wantContains)
		}
		if c.wantNoExt && strings.Contains(got, ".pdf") {
			t.Errorf("%s: %q 不应残留扩展名", c.name, got)
		}
		if !strings.HasPrefix(got, "该文档以公式/图表为主，根据文件名及上下文推断，核心内容定位为：") {
			t.Errorf("%s: 前缀不符，got %q", c.name, got)
		}
	}
}

func TestKbL3NewLimit(t *testing.T) {
	cases := []struct {
		textLength int
		want       int
	}{
		{0, 3}, {2999, 3}, {3000, 4}, {5999, 4}, {6000, 5}, {100000, 5},
	}
	for _, c := range cases {
		if got := kbL3NewLimit(c.textLength); got != c.want {
			t.Errorf("kbL3NewLimit(%d) = %d, want %d", c.textLength, got, c.want)
		}
	}
}

func TestKbRecordText(t *testing.T) {
	cases := []struct {
		name string
		rec  map[string]any
		want string
	}{
		{"content 优先", map[string]any{"content": "C", "title": "T", "name": "N"}, "C"},
		{"title 次之", map[string]any{"title": "T", "name": "N"}, "T"},
		{"name 再次", map[string]any{"name": "N", "description": "D"}, "N"},
		{"description 兜底", map[string]any{"description": "D"}, "D"},
		{"空 content 下落", map[string]any{"content": "", "title": "T"}, "T"},
		{"全空", map[string]any{"content": ""}, ""},
		{"非字符串忽略", map[string]any{"content": 42, "title": "T"}, "T"},
	}
	for _, c := range cases {
		if got := kbRecordText(c.rec); got != c.want {
			t.Errorf("%s: kbRecordText = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestKbRound2(t *testing.T) {
	// JS：Math.round(x*100)/100——先乘 100 再取整，负数 half 向 +∞ 舍入
	cases := []struct {
		in   float64
		want float64
	}{
		{540, 540},
		{540.123456, 540.12},
		{540.129, 540.13},
		{-0.5, -0.5},    // x*100 = -50（整数），Math.round(-50) = -50
		{-2.678, -2.68}, // 最近邻：-267.8 → -268
		{0.005, 0.01},   // IEEE 下 0.005*100 = 0.5000000000000001 > 0.5，JS 同
	}
	for _, c := range cases {
		if got := kbRound2(c.in); got != c.want {
			t.Errorf("kbRound2(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestKbExtractJSONArray(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{`前置文字 ["a","b"] 后置文字`, `["a","b"]`, true},
		{"no brackets", "", false},
		{"[only start", "", false},
		{`x [1,2] y [3] z`, `[1,2] y [3]`, true}, // 贪婪：首个 [ 到最后一个 ]
	}
	for _, c := range cases {
		got, ok := kbExtractJSONArray(c.in)
		if ok != c.wantOK || got != c.want {
			t.Errorf("kbExtractJSONArray(%q) = (%q,%v), want (%q,%v)", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

func TestKbJSONStringifyNoHTMLEscape(t *testing.T) {
	got := kbJSONStringify([]string{"/数学/分析/"})
	if got != `["/数学/分析/"]` {
		t.Errorf("kbJSONStringify 中文原样输出: got %q", got)
	}
	// Go 默认 json.Marshal 会把 <>& 转成 \u003c 等；TS JSON.stringify 不会
	got = kbJSONStringify([]string{"<a&b>"})
	if got != `["<a&b>"]` {
		t.Errorf("kbJSONStringify 不应 HTML 转义: got %q", got)
	}
}

func TestKbAdjacentAndFirstOccurrenceDedup(t *testing.T) {
	// consolidateTags 用相邻去重；l3-consolidate 用首现去重——两者行为必须区分
	tags := []string{"A", "A", "B", "A", "B", "B"}
	if got := kbAdjacentDedup(tags); strings.Join(got, ",") != "A,B,A,B" {
		t.Errorf("kbAdjacentDedup = %v, want [A B A B]", got)
	}
	if got := kbFirstOccurrenceDedup(tags); strings.Join(got, ",") != "A,B" {
		t.Errorf("kbFirstOccurrenceDedup = %v, want [A B]", got)
	}
}

func TestKbReplaceTagInPaths(t *testing.T) {
	paths := []string{"/数学/复分析/留数定理/", "/其他/复分析/"}
	got := kbReplaceTagInPaths(paths, "复分析", "复变函数")
	want := []string{"/数学/复变函数/留数定理/", "/其他/复变函数/"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("kbReplaceTagInPaths[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	// 每条路径只替换首个出现（JS String.replace 非全局）
	got = kbReplaceTagInPaths([]string{"/a/a/"}, "a", "b")
	if got[0] != "/b/a/" {
		t.Errorf("非全局替换：got %q, want /b/a/", got[0])
	}
}

func TestKbParsePathsOrLegacy(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"JSON 数组", `["/a/","/b/"]`, []string{"/a/", "/b/"}},
		{"空串按 [] 解析为空数组", "", []string{}},
		{"裸字符串（legacy）", "/数学/", []string{"/数学/"}},
		{"JSON 对象（legacy）", `{"x":1}`, []string{`{"x":1}`}},
		{"JSON 数字（legacy）", `42`, []string{"42"}},
	}
	for _, c := range cases {
		got := kbParsePathsOrLegacy(c.in)
		if strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("%s: kbParsePathsOrLegacy(%q) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

func TestKbRankL3s(t *testing.T) {
	entries := []kbL3Papercore{
		{Name: "对偶理论", Papercore: "对偶定理与影子价格"},
		{Name: "排队论", Papercore: "到达率与服务率"},
		{Name: "网络优化", Papercore: "最短路问题"},
	}
	// papercore 提到“对偶/定理/价格”
	got := kbRankL3s(entries, "对偶理论：对偶定理与影子价格分析", 2)
	if len(got) != 2 {
		t.Fatalf("topK=2 应返回 2 条，got %d", len(got))
	}
	if got[0].Name != "对偶理论" {
		t.Errorf("字符重叠最高的应排第一，got %q", got[0].Name)
	}
	// papercore 截 200 字
	long := strings.Repeat("字", 300)
	got = kbRankL3s([]kbL3Papercore{{Name: "X", Papercore: long}}, "X", 8)
	if kbUTF16Len(got[0].Papercore) != 200 {
		t.Errorf("papercore 应截 200 字，got %d", kbUTF16Len(got[0].Papercore))
	}
}

func TestKbBuildTagGraph(t *testing.T) {
	docs := []kbGraphDoc{
		{RecordID: "note_1", Tags: []string{"数学", "运筹学", "对偶理论", "排队论"}},
		{RecordID: "material_2", Tags: []string{"数学", "运筹学", "对偶理论"}},
		{RecordID: "node_3", Tags: []string{"计算机科学", "数据挖掘"}},
		{RecordID: "note_4", Tags: nil}, // 无标签跳过
	}
	g := kbBuildTagGraph(docs)

	if g.TotalRecords != 4 {
		t.Errorf("totalRecords = %d, want 4（含无标签记录）", g.TotalRecords)
	}
	if g.Canvas.Width != 1200 || g.Canvas.Height != 900 {
		t.Errorf("canvas = %v", g.Canvas)
	}

	// 节点：2 L1 + 2 L2 + 2 L3 = 6
	if len(g.Nodes) != 6 {
		t.Fatalf("nodes = %d, want 6: %v", len(g.Nodes), g.Nodes)
	}
	byID := map[string]kbTagNode{}
	var order []string
	for _, n := range g.Nodes {
		byID[n.ID] = n
		order = append(order, n.ID)
	}
	// 插入序：首个文档先建 L1 数学 → L2 → L3……计算机科学在第三条记录
	if order[0] != "tag_L1_数学" {
		t.Errorf("首个节点应为 tag_L1_数学，got %q", order[0])
	}

	l1 := byID["tag_L1_数学"]
	if l1.Count != 2 || len(l1.DocumentIDs) != 2 {
		t.Errorf("L1 数学 count/documents 应为 2，got %d/%v", l1.Count, l1.DocumentIDs)
	}
	if l1.ParentID != "" {
		t.Errorf("L1 不应有 parentId（JSON 省略），got %q", l1.ParentID)
	}
	l2 := byID["tag_L2_数学_运筹学"]
	if l2.ParentID != "tag_L1_数学" || len(l2.Children) != 2 {
		t.Errorf("L2 parent/children 不符: %+v", l2)
	}
	l3 := byID["tag_L3_数学_运筹学_对偶理论"]
	if l3.Count != 2 || len(l3.DocumentIDs) != 2 {
		t.Errorf("对偶理论 count 应为 2，got %d", l3.Count)
	}
	if len(byID["tag_L1_计算机科学"].Children) != 1 {
		t.Errorf("计算机科学应有 1 个 L2 子节点")
	}

	// 边：层级边 4 条（2 L2 + 2 L3）+ 共现边（对偶理论×排队论 等对）
	hierarchy, cooccurrence := 0, 0
	for _, e := range g.Edges {
		switch e.Type {
		case "hierarchy":
			hierarchy++
			if e.Weight != 0 {
				t.Errorf("层级边不应有 weight")
			}
		case "cooccurrence":
			cooccurrence++
			if e.Weight < 1 {
				t.Errorf("共现边 weight 应 ≥1")
			}
		}
	}
	if hierarchy != 4 {
		t.Errorf("hierarchy edges = %d, want 4", hierarchy)
	}
	if cooccurrence == 0 {
		t.Errorf("同文档标签对应产生共现边")
	}

	// 领域圈按 L2 生成
	if len(g.Domains) != 2 {
		t.Fatalf("domains = %d, want 2", len(g.Domains))
	}
	if g.Domains[0].Name != "运筹学" || g.Domains[0].Count != 2 {
		t.Errorf("domains[0] 应为运筹学(count 2)，got %+v", g.Domains[0])
	}
	if g.Domains[0].R < 70 {
		t.Errorf("领域半径下限 70，got %d", g.Domains[0].R)
	}

	// JSON 形状抽查：parentId 在 L1 上省略、children 恒为数组
	b, err := json.Marshal(byID["tag_L1_数学"])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, exists := m["parentId"]; exists {
		t.Errorf("L1 节点 JSON 不应含 parentId 键: %s", b)
	}
	if ch, ok := m["children"].([]any); !ok || len(ch) != 1 {
		t.Errorf("L1 children 应为长度 1 的数组: %s", b)
	}
	// 坐标在画布内
	for _, n := range g.Nodes {
		if n.X < 0 || n.X > 1200 || n.Y < 0 || n.Y > 900 {
			t.Errorf("节点 %s 坐标越界: (%v,%v)", n.ID, n.X, n.Y)
		}
	}
}

func TestKbBuildTagGraphEmpty(t *testing.T) {
	g := kbBuildTagGraph(nil)
	if len(g.Nodes) != 0 || len(g.Edges) != 0 || len(g.Domains) != 0 || g.TotalRecords != 0 {
		t.Errorf("空输入应产出空图: %+v", g)
	}
	// nodes 序列化为 []（非 null）
	b, _ := json.Marshal(g)
	if !strings.Contains(string(b), `"nodes":[]`) {
		t.Errorf("空 nodes 应序列化为 []: %s", b)
	}
}

func TestKbGraphCooccurrenceTop50(t *testing.T) {
	// 60 个 L3 同挂一个文档 → 共现对 C(60,2)=1770 > 50，只保留 top 50
	tags := []string{"数学", "运筹学"}
	for i := 0; i < 60; i++ {
		tags = append(tags, "标签"+string(rune('A'+i)))
	}
	g := kbBuildTagGraph([]kbGraphDoc{{RecordID: "material_9", Tags: tags}})
	cooc := 0
	for _, e := range g.Edges {
		if e.Type == "cooccurrence" {
			cooc++
		}
	}
	if cooc != 50 {
		t.Errorf("共现边应截 top50，got %d", cooc)
	}
}

func TestKbTagHierarchyOperations(t *testing.T) {
	h := &kbTagHierarchy{}
	h.addL1("数学")
	h.addL1("数学") // 去重
	h.addL2("运筹学")
	h.addL3("对偶理论")
	if len(h.L1) != 1 || len(h.L2) != 1 || len(h.L3) != 1 {
		t.Errorf("层级集合去重失败: %+v", h)
	}
	h.addL1("") // 空值不入集合
	if len(h.L1) != 1 {
		t.Errorf("空字符串不应入集合")
	}
	h.removeL2("运筹学")
	if len(h.L2) != 0 {
		t.Errorf("removeL2 失败")
	}
}

func TestKbL1L2Tree(t *testing.T) {
	tree := &kbL1L2Tree{}
	tree.add("数学", "运筹学")
	tree.add("数学", "复分析")
	tree.add("数学", "运筹学") // 去重
	tree.add("计算机科学", "数据挖掘")

	if tree.size() != 2 {
		t.Fatalf("L1 数 = %d, want 2", tree.size())
	}
	keys := tree.keys()
	if keys[0] != "数学" || keys[1] != "计算机科学" {
		t.Errorf("插入序错误: %v", keys)
	}
	if !tree.has("数学", "复分析") || tree.has("数学", "数据挖掘") {
		t.Errorf("has 判定错误")
	}
	formatted := kbFormatL1L2Tree(tree)
	want := "  数学\n    └─ 运筹学\n    └─ 复分析\n  计算机科学\n    └─ 数据挖掘"
	if formatted != want {
		t.Errorf("格式化结果:\n%q\nwant:\n%q", formatted, want)
	}
	if kbFormatL1L2Tree(&kbL1L2Tree{}) != "" {
		t.Errorf("空树应格式化为空串")
	}
}

func TestKbJSOrAndFilterEmpty(t *testing.T) {
	if kbJSOr("", "fallback") != "fallback" || kbJSOr("x", "y") != "x" {
		t.Errorf("kbJSOr 语义错误")
	}
	got := kbFilterEmpty([]string{"", "A", "", "B", ""})
	if strings.Join(got, ",") != "A,B" {
		t.Errorf("kbFilterEmpty = %v", got)
	}
}

func TestKbStringSlice(t *testing.T) {
	var arr []any
	arr = append(arr, "a", nil, float64(5), true)
	got := kbStringSlice(arr)
	want := []string{"a", "null", "5", "true"} // JS String() 语义
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("kbStringSlice[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if kbStringSlice(nil) != nil || kbStringSlice("not array") != nil {
		t.Errorf("非数组应返回 nil")
	}
}

func TestKbRecordFileName(t *testing.T) {
	cases := []struct {
		rec  map[string]any
		want string
	}{
		{map[string]any{"name": "N", "title": "T", "file_name": "F"}, "N"},
		{map[string]any{"title": "T", "file_name": "F"}, "T"},
		{map[string]any{"file_name": "F"}, "F"},
		{map[string]any{}, ""},
	}
	for _, c := range cases {
		if got := kbRecordFileName(c.rec); got != c.want {
			t.Errorf("kbRecordFileName(%v) = %q, want %q", c.rec, got, c.want)
		}
	}
}

func TestKbCollapseJSSpace(t *testing.T) {
	if got := kbCollapseJSSpace("a \t\n b"); got != "a b" {
		t.Errorf("kbCollapseJSSpace = %q, want \"a b\"", got)
	}
	// \u3000（全角空格）属于 JS \s
	if got := kbCollapseJSSpace("a\u3000\u3000b"); got != "a b" {
		t.Errorf("全角空格应被压缩: %q", got)
	}
}

func TestKbParseProposedTags(t *testing.T) {
	tags, err := kbParseProposedTags(`["对偶理论","","排队论",null,false,0]`)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if strings.Join(tags, ",") != "对偶理论,排队论" {
		t.Errorf("filter(Boolean) 语义: %v", tags)
	}
	// 非数组 → 错误（TS JSON.parse 后 .filter 抛 TypeError）
	if _, err := kbParseProposedTags(`{"a":1}`); err == nil {
		t.Errorf("非数组应报错")
	}
	// 非字符串元素 → 错误（TS 在 charOverlapRatio 处 throw）
	if _, err := kbParseProposedTags(`["a",5]`); err == nil {
		t.Errorf("非字符串元素应报错")
	}
}

func TestKbIsPostgrestError(t *testing.T) {
	if kbIsPostgrestError(nil) {
		t.Errorf("nil 不是 Postgrest 错误")
	}
	if !kbIsPostgrestError(postgrestErrorForTest) {
		t.Errorf("PostgrestError 应判定为 true")
	}
	if kbIsPostgrestError(errPlainForTest) {
		t.Errorf("普通错误应判定为 false")
	}
}

func TestKbHierarchyFromRowsEmptyShortTags(t *testing.T) {
	// 回归：tags=[] 与 tags 长度 1 的行不得 panic（JS slice(2) 空数组语义）。
	// 对拍实测：上传资料的 tags=[] 曾在 tagArr[2:] 处击穿整个服务进程。
	rows := []map[string]any{
		{"tags": []any{}},
		{"tags": []any{"Math"}},
		{"tags": []any{"Math", "Analysis"}},
		{"tags": []any{"Math", "Analysis", "Fourier", "Laplace"}},
		{"tags": nil},
		{"tags": "not-array"},
	}
	h := kbHierarchyFromRows(rows)
	if len(h.L1) != 1 || h.L1[0] != "Math" {
		t.Fatalf("L1 = %v, want [Math]", h.L1)
	}
	if len(h.L2) != 1 || h.L2[0] != "Analysis" {
		t.Fatalf("L2 = %v, want [Analysis]", h.L2)
	}
	if len(h.L3) != 2 || h.L3[0] != "Fourier" || h.L3[1] != "Laplace" {
		t.Fatalf("L3 = %v, want [Fourier Laplace]", h.L3)
	}
}
