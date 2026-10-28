package retrieval

import (
	"context"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestChunkPages(t *testing.T) {
	short1 := strings.Repeat("一", 25)
	short2 := strings.Repeat("二", 25)
	cases := []struct {
		name   string
		text   string
		pages  []string
		chunks []passageChunk
	}{
		{"空文本", "", nil, nil},
		{"纯空白页", "   \f\t\f ", nil, nil},
		{"单短页成块", short1, []string{short1}, []passageChunk{{1, short1}}},
		{"不足 20 字的页不入块", "太短的页", []string{"太短的页"}, nil},
		{
			// 空白页被丢弃，后续页码按过滤后的顺序编号（与 TS 一致）
			name:   "空白中页丢弃且页码前移",
			text:   short1 + "\f\f" + short2,
			pages:  []string{short1, short2},
			chunks: []passageChunk{{1, short1}, {2, short2}},
		},
		{
			// 401 个 A + 换行 + 200 个 B：断点落在换行后（i+1），尾随换行被 trim
			name:   "换行优先断点",
			text:   strings.Repeat("A", 401) + "\n" + strings.Repeat("B", 200),
			pages:  []string{strings.Repeat("A", 401) + "\n" + strings.Repeat("B", 200)},
			chunks: []passageChunk{{1, strings.Repeat("A", 401)}, {1, strings.Repeat("B", 200)}},
		},
		{
			// 480 个 A + 句号 + 100 个 B：句末标点作次优先断点
			name:   "句末标点断点",
			text:   strings.Repeat("A", 480) + "。" + strings.Repeat("B", 100),
			pages:  []string{strings.Repeat("A", 480) + "。" + strings.Repeat("B", 100)},
			chunks: []passageChunk{{1, strings.Repeat("A", 480) + "。"}, {1, strings.Repeat("B", 100)}},
		},
		{
			// 无任何断点：在 500 处硬切，余下 81 字为第二块
			name:   "无断点硬切",
			text:   strings.Repeat("A", 581),
			pages:  []string{strings.Repeat("A", 581)},
			chunks: []passageChunk{{1, strings.Repeat("A", 500)}, {1, strings.Repeat("A", 81)}},
		},
		{
			// 第二块以顿号开头：块首空白/顿号被剥掉
			name:   "块首顿号剥离",
			text:   strings.Repeat("A", 500) + "、" + strings.Repeat("B", 40),
			pages:  []string{strings.Repeat("A", 500) + "、" + strings.Repeat("B", 40)},
			chunks: []passageChunk{{1, strings.Repeat("A", 500)}, {1, strings.Repeat("B", 40)}},
		},
		{
			// 剥离后不足 20 字的块丢弃
			name:   "剥离后过短丢弃",
			text:   strings.Repeat("A", 500) + "、" + strings.Repeat("B", 5),
			pages:  []string{strings.Repeat("A", 500) + "、" + strings.Repeat("B", 5)},
			chunks: []passageChunk{{1, strings.Repeat("A", 500)}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pages, chunks := chunkPages(tc.text)
			if !reflect.DeepEqual(pages, tc.pages) {
				t.Errorf("pages = %q, want %q", pages, tc.pages)
			}
			if !reflect.DeepEqual(chunks, tc.chunks) {
				t.Errorf("chunks = %+v, want %+v", chunks, tc.chunks)
			}
		})
	}
}

func TestChunkPagesCap(t *testing.T) {
	// 200000 字无断点长页：理论 400 块，截断到 300（MAX_CHUNKS_PER_FILE）
	_, chunks := chunkPages(strings.Repeat("x", 200000))
	if len(chunks) != maxChunksPerFile {
		t.Fatalf("块数 = %d, want %d", len(chunks), maxChunksPerFile)
	}
	if len([]rune(chunks[len(chunks)-1].text)) != chunkSize {
		t.Errorf("截断时最后一块应为整块 500 字，got %d", len([]rune(chunks[len(chunks)-1].text)))
	}
}

func TestChunkPagesShortPagesNotCapped(t *testing.T) {
	// 短页（≤500 字）整页成块，不受 300 上限约束（与 TS 一致）
	var sb strings.Builder
	for i := 0; i < maxChunksPerFile+50; i++ {
		if i > 0 {
			sb.WriteString("\f")
		}
		sb.WriteString(strings.Repeat("字", 25))
	}
	pages, chunks := chunkPages(sb.String())
	if len(pages) != maxChunksPerFile+50 || len(chunks) != maxChunksPerFile+50 {
		t.Errorf("短页不受截断：pages=%d chunks=%d", len(pages), len(chunks))
	}
}

func TestBigramScore(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want float64
	}{
		{"完全一致", "abc", "abc", 1},
		{"无重合", "abcd", "zz", 0},
		{"部分重合", "abcd", "ab", 1.0 / 3},
		{"查询无 bigram", "a", "a", 0},
		{"查询为空白", "  ", "x", 0},
		{"空白不参与", "a b", "ab", 1},
		{"中文重合", "你好世界", "世界你好", 2.0 / 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bigramScore(tc.a, tc.b); math.Abs(got-tc.want) > 1e-12 {
				t.Errorf("bigramScore(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestLooksLikeCover(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"标题+教材整理信号", "# 高等数学教材整理配套手册与目录", true},
		{"二级标题+来源信号", "## 来源：某某出版社", true},
		{"制表符也是标题空白", "#\t课件第一册说明内容补充行", true},
		{"四个#不算标题", "#### 课件说明", false},
		{"无标题记号", "教材整理第一章", false},
		{"标题无信号词", "# 纯标题没有任何标志词", false},
		{"超过 600 字不算封面", "#" + strings.Repeat("课件", 400), false},
		{"空串", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikeCover(tc.in); got != tc.want {
				t.Errorf("looksLikeCover(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestLocatePassageBigramFallback(t *testing.T) {
	// 嵌入全不可用：查询向量与块向量都退化为 bigram 字面打分
	withStubEmbedders(t, nil, nil)

	cover := "# 高等数学教材整理配套习题与详细目录索引"
	body := "函数的连续性与极限是高等数学的基础内容，需要掌握严格的定义描述"

	// 封面块与查询重合度更高，但第一轮被跳过 → 命中正文块（第 2 页）
	hit, err := LocatePassage(context.Background(), "bigram-cover-skip", cover+"\f"+body, "高等数学教材整理")
	if err != nil {
		t.Fatalf("LocatePassage: %v", err)
	}
	if hit == nil {
		t.Fatal("应命中正文块")
	}
	if hit.PageNumber != 2 {
		t.Errorf("PageNumber = %d, want 2（封面块应被第一轮跳过）", hit.PageNumber)
	}
	if hit.Text != body {
		t.Errorf("命中文字不符：%q", hit.Text)
	}
	if hit.Score < minPassageScore {
		t.Errorf("Score = %v 应不低于阈值 %v", hit.Score, minPassageScore)
	}

	// 只有封面匹配：第一轮无候选，第二轮放开封面兜底
	hit, err = LocatePassage(context.Background(), "bigram-cover-fallback", cover, "高等数学教材整理")
	if err != nil {
		t.Fatalf("LocatePassage: %v", err)
	}
	if hit == nil || hit.PageNumber != 1 {
		t.Fatalf("第二轮应放开封面块兜底，got %+v", hit)
	}

	// 重合度过低：低于 0.2 视为未定位
	hit, err = LocatePassage(context.Background(), "bigram-miss", cover+"\f"+body, "完全无关的提问内容")
	if err != nil {
		t.Fatalf("LocatePassage: %v", err)
	}
	if hit != nil {
		t.Errorf("低重合应返回 nil，got %+v", hit)
	}

	// 空文本：无块 → nil
	hit, err = LocatePassage(context.Background(), "bigram-empty", "", "任意查询")
	if err != nil || hit != nil {
		t.Errorf("空文本应返回 (nil,nil)，got (%+v,%v)", hit, err)
	}
}

func TestLocatePassageVectorPath(t *testing.T) {
	page1 := strings.Repeat("甲", 30)
	page2 := strings.Repeat("乙", 30)
	// 块向量用单位向量区分：块 0 → e0，块 1 → e1
	withStubEmbedders(
		t,
		func(string) ([]float64, error) { return []float64{0, 1}, nil }, // 查询向量与块 1 同向
		func(texts []string) ([][]float64, error) {
			vecs := make([][]float64, len(texts))
			for i := range texts {
				if i%2 == 0 {
					vecs[i] = []float64{1, 0}
				} else {
					vecs[i] = []float64{0, 1}
				}
			}
			return vecs, nil
		},
	)
	hit, err := LocatePassage(context.Background(), "vec-basic", page1+"\f"+page2, "查询")
	if err != nil {
		t.Fatalf("LocatePassage: %v", err)
	}
	if hit == nil || hit.PageNumber != 2 || hit.Score != 1 {
		t.Errorf("向量路径应命中第 2 页满分，got %+v", hit)
	}
}

func TestLocatePassageQueryVecOnlySucceeds(t *testing.T) {
	// 查询嵌入可用、块嵌入失败：块向量空 → 余弦 0 分 < 0.2 → 未定位
	withStubEmbedders(
		t,
		func(string) ([]float64, error) { return []float64{1}, nil },
		func([]string) ([][]float64, error) { return nil, context.DeadlineExceeded },
	)
	hit, err := LocatePassage(context.Background(), "vec-partial", strings.Repeat("丙", 30), "查询")
	if err != nil || hit != nil {
		t.Errorf("期望 (nil,nil)，got (%+v,%v)", hit, err)
	}
}

func TestPassageCacheKeySeparatesTextLengths(t *testing.T) {
	// 缓存键含文本长度指纹（`${key}::${fileText.length}`）：
	// 同 cacheKey、不同长度的文本应各自建索引，不得复用旧索引
	withStubEmbedders(t, nil, nil)    // bigram 兜底
	pageA := strings.Repeat("答案", 20) // 40 字，命中查询
	noise := strings.Repeat("无无", 20) // 40 字，不命中
	short := pageA
	long := noise + "\f" + pageA
	h1, _ := LocatePassage(context.Background(), "same-key", short, "答案")
	h2, _ := LocatePassage(context.Background(), "same-key", long, "答案")
	if h1 == nil || h2 == nil {
		t.Fatalf("两次都应命中：%+v / %+v", h1, h2)
	}
	if h1.PageNumber != 1 || h2.PageNumber != 2 {
		t.Errorf("缓存键应区分文本长度：h1=%d h2=%d, want 1/2", h1.PageNumber, h2.PageNumber)
	}
}
