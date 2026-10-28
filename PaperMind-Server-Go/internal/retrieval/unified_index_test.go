package retrieval

import (
	"context"
	"errors"
	"testing"
)

// isolateGlobalTagStore 把全局标签库换成未就绪的空库（跳过标签加成），
// 测试结束后恢复原指针。
func isolateGlobalTagStore(t *testing.T) {
	t.Helper()
	old := tagVectorStore
	tagVectorStore = &TagVectorStore{}
	t.Cleanup(func() { tagVectorStore = old })
}

func TestUnifiedSearch(t *testing.T) {
	withStubEmbedders(t, func(string) ([]float64, error) { return []float64{1, 0}, nil }, nil)
	isolateGlobalTagStore(t)

	idx := &UnifiedVectorIndex{}
	idx.mu.Lock()
	idx.records = []indexRecord{
		{sourceType: SourceStudyNote, sourceID: 7, title: "纪要A", papercore: "p1", tags: []string{"数学"}, vec: []float64{0.9, 0.1}},
		{sourceType: SourceMaterial, sourceID: 8, title: "资料B", papercore: "p2", tags: []string{}, vec: []float64{0.2, 0}},
		{sourceType: SourceStudyNote, sourceID: 9, title: "纪要C", papercore: "p3", tags: []string{"物理"}, vec: []float64{-1, 0}},
	}
	idx.ready = true
	idx.mu.Unlock()

	ctx := context.Background()

	// minScore 0.3：0.9 过线、0.2 与 -1 出局
	res, err := idx.Search(ctx, "查询", 10, 0.3)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(res) != 1 {
		t.Fatalf("结果数 = %d, want 1（got %+v）", len(res), res)
	}
	r := res[0]
	if r.SourceType != SourceStudyNote || r.SourceID.(int) != 7 || r.Title != "纪要A" ||
		r.Papercore != "p1" || len(r.Tags) != 1 || r.Tags[0] != "数学" {
		t.Errorf("字段映射不符： %+v", r)
	}
	if r.RawScore != 0.9 || r.Score != 0.9 {
		t.Errorf("分数不符：raw %v score %v（无标签加成时两者应相等）", r.RawScore, r.Score)
	}

	// topK 截断：阈值 0 放行 0.9 与 0.2，topK=1 只留最高分
	res, err = idx.Search(ctx, "查询", 1, 0)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(res) != 1 || res[0].SourceID.(int) != 7 {
		t.Errorf("topK=1 结果 = %+v", res)
	}

	// 阈值过高 → 空数组（非 nil，JSON 序列化为 [] 而非 null）
	res, err = idx.Search(ctx, "查询", 10, 0.95)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res == nil || len(res) != 0 {
		t.Errorf("期望空非 nil 切片，got %#v", res)
	}
}

func TestUnifiedSearchEmptyIndex(t *testing.T) {
	withStubEmbedders(t, nil, nil)
	isolateGlobalTagStore(t)
	idx := &UnifiedVectorIndex{}
	idx.mu.Lock()
	idx.ready = true // 已就绪 + 空索引：不再触发构建
	idx.mu.Unlock()

	res, err := idx.Search(context.Background(), "q", 10, 0.3)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res == nil || len(res) != 0 {
		t.Errorf("期望空非 nil 切片，got %#v", res)
	}
}

func TestUnifiedSearchEmbedFailure(t *testing.T) {
	withStubEmbedders(t, func(string) ([]float64, error) { return nil, errors.New("embed down") }, nil)
	isolateGlobalTagStore(t)
	idx := &UnifiedVectorIndex{}
	idx.mu.Lock()
	idx.records = []indexRecord{{sourceType: SourceMaterial, sourceID: 1, tags: []string{}, vec: []float64{1}}}
	idx.ready = true
	idx.mu.Unlock()

	if _, err := idx.Search(context.Background(), "q", 10, 0); err == nil {
		t.Error("查询嵌入失败应返回错误（TS 侧 catch 后返回空数组，Go 交给 handler 降级）")
	}
}

func TestApplyTagBoost(t *testing.T) {
	store := &TagVectorStore{}
	store.mu.Lock()
	store.tags = []TagEntry{
		{ID: "L1_数学", Name: "数学", Level: TagL1, Vec: []float64{1, 0, 0, 0}}, // 与查询同向 → 1.0 ≥ 0.25
		{ID: "L2_代数", Name: "代数", Level: TagL2, Vec: []float64{0, 1, 0, 0}}, // 0 分 < 0.2，不进 semL2
		{ID: "L3_方程", Name: "方程", Level: TagL3, Vec: []float64{0, 0, 0, 0}},
		{ID: "L3_几何", Name: "几何", Level: TagL3, Vec: []float64{0, 0, 0, 0}}, // 靠字面命中
	}
	store.initialized = true
	store.mu.Unlock()

	queryVec := []float64{1, 0, 0, 0}
	query := "几何题目"

	scored := []scoredItem{
		{rec: &indexRecord{tags: []string{"数学", "代数", "方程"}}, rawScore: 0.5, score: 0.5},
		{rec: &indexRecord{tags: []string{"代数", "几何", "方程"}}, rawScore: 0.4, score: 0.4},
		{rec: &indexRecord{tags: []string{"x", "y", "几何", "方程", "函数"}}, rawScore: 0.4, score: 0.4},
		{rec: &indexRecord{tags: []string{"物理"}}, rawScore: 0.9, score: 0.9},
		{rec: &indexRecord{tags: []string{}}, rawScore: 0.9, score: 0.9},
	}

	tags, boosted := applyTagBoost(store, query, queryVec, scored)
	if len(tags) != 2 || tags[0] != "数学" || tags[1] != "几何" {
		t.Errorf("queryTags = %v, want [数学 几何]（语义 L1 先于字面命中）", tags)
	}
	if boosted != 3 {
		t.Errorf("boosted = %d, want 3", boosted)
	}
	// 期望值用与实现一致的“运行时浮点运算”构造（常量表达式会被编译器
	// 精确折叠，与逐次舍入的实现结果差 1ulp）
	boostL1, boostL2, boostL3 := 0.02, 0.05, 0.1
	wantScores := []float64{
		0.5 * (1 + boostL1), // 数学@idx0：L1 弱信号
		0.4 * (1 + boostL2), // 几何@idx1：L2 中信号
		0.4 * (1 + boostL3), // 几何@idx2：L3 强信号
		0.9,                 // 无命中
		0.9,                 // 空 tags 跳过
	}
	for i, want := range wantScores {
		if scored[i].score != want {
			t.Errorf("scored[%d].score = %v, want %v", i, scored[i].score, want)
		}
	}
}

func TestApplyTagBoostCap(t *testing.T) {
	store := &TagVectorStore{}
	store.mu.Lock()
	store.tags = []TagEntry{
		{ID: "L1_数学", Name: "数学", Level: TagL1, Vec: []float64{1}},
		{ID: "L3_几何", Name: "几何", Level: TagL3},
		{ID: "L3_方程", Name: "方程", Level: TagL3},
		{ID: "L3_函数", Name: "函数", Level: TagL3},
		{ID: "L3_极限", Name: "极限", Level: TagL3},
		{ID: "L3_向量", Name: "向量", Level: TagL3},
	}
	store.initialized = true
	store.mu.Unlock()

	// 六个标签全部字面命中：0.02+0.05+0.1*4 = 0.47 → 封顶 0.3
	scored := []scoredItem{
		{rec: &indexRecord{tags: []string{"数学", "几何", "方程", "函数", "极限", "向量"}}, rawScore: 0.5, score: 0.5},
	}
	_, boosted := applyTagBoost(store, "数学几何方程函数极限向量总复习", []float64{1}, scored)
	if boosted != 1 {
		t.Fatalf("boosted = %d, want 1", boosted)
	}
	if want := 0.5 * (1 + tagBoostFactor); scored[0].score != want {
		t.Errorf("封顶后 score = %v, want %v", scored[0].score, want)
	}
}

func TestApplyTagBoostStoreNotReady(t *testing.T) {
	scored := []scoredItem{{rec: &indexRecord{tags: []string{"数学"}}, rawScore: 0.5, score: 0.5}}
	tags, boosted := applyTagBoost(&TagVectorStore{}, "数学", []float64{1}, scored)
	if tags != nil || boosted != 0 {
		t.Errorf("未就绪的标签库不应参与加成：tags=%v boosted=%d", tags, boosted)
	}
	if scored[0].score != 0.5 {
		t.Errorf("分数不应变化，got %v", scored[0].score)
	}
}

func TestUnifiedRecordCount(t *testing.T) {
	idx := &UnifiedVectorIndex{}
	if idx.RecordCount() != 0 {
		t.Errorf("空索引 RecordCount = %d", idx.RecordCount())
	}
	idx.mu.Lock()
	idx.records = []indexRecord{{}, {}}
	idx.mu.Unlock()
	if idx.RecordCount() != 2 {
		t.Errorf("RecordCount = %d, want 2", idx.RecordCount())
	}
}
