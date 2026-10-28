package retrieval

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestBuildFromHierarchy(t *testing.T) {
	withStubEmbedders(t, nil, func(texts []string) ([][]float64, error) {
		vecs := make([][]float64, len(texts))
		for i := range texts {
			vecs[i] = []float64{float64(i)} // 用序号当向量指纹
		}
		return vecs, nil
	})
	s := &TagVectorStore{}
	err := s.BuildFromHierarchy(context.Background(), TagHierarchy{
		L1: []string{"数学", ""},
		L2: []string{"代数"},
		L3: []string{"方程", "几何"},
	})
	if err != nil {
		t.Fatalf("BuildFromHierarchy: %v", err)
	}
	want := []TagEntry{
		{ID: "L1_数学", Name: "数学", Level: TagL1, Vec: []float64{0}},
		{ID: "L2_代数", Name: "代数", Level: TagL2, Vec: []float64{1}},
		{ID: "L3_方程", Name: "方程", Level: TagL3, Vec: []float64{2}},
		{ID: "L3_几何", Name: "几何", Level: TagL3, Vec: []float64{3}},
	}
	if !reflect.DeepEqual(s.tags, want) {
		t.Errorf("tags = %+v, want %+v", s.tags, want)
	}
	if !s.IsReady() {
		t.Error("构建成功后 IsReady 应为 true")
	}
	if s.Count() != 4 {
		t.Errorf("Count = %d, want 4", s.Count())
	}
}

func TestBuildFromHierarchyEmpty(t *testing.T) {
	invoked := false
	withStubEmbedders(t, nil, func([]string) ([][]float64, error) {
		invoked = true
		return nil, nil
	})
	s := &TagVectorStore{}
	if err := s.BuildFromHierarchy(context.Background(), TagHierarchy{}); err != nil {
		t.Fatalf("BuildFromHierarchy: %v", err)
	}
	if invoked {
		t.Error("空层级不应触发嵌入请求")
	}
	if !s.IsReady() {
		t.Error("空层级也应标记 initialized=true（TS:89-92 语义）")
	}
	if s.Count() != 0 {
		t.Errorf("Count = %d, want 0", s.Count())
	}
}

func TestBuildFromHierarchyEmbedFailure(t *testing.T) {
	withStubEmbedders(t, nil, func([]string) ([][]float64, error) {
		return nil, errors.New("boom")
	})
	s := &TagVectorStore{}
	s.initialized = true // 预置已初始化状态
	err := s.BuildFromHierarchy(context.Background(), TagHierarchy{L3: []string{"方程"}})
	if err == nil || err.Error() != "boom" {
		t.Fatalf("应上抛嵌入错误，got %v", err)
	}
	if s.Count() != 0 {
		t.Errorf("失败后 tags 应被清空，Count = %d", s.Count())
	}
	// TS 版没有 catch：失败时 initialized 保持原值（与 BuildFromDatabase 不同）
	if !s.IsReady() {
		t.Error("失败时 initialized 应保持原值 true")
	}
}

func TestAddTags(t *testing.T) {
	withStubEmbedders(t, nil, func(texts []string) ([][]float64, error) {
		vecs := make([][]float64, len(texts))
		for i := range texts {
			vecs[i] = []float64{float64(100 + i)}
		}
		return vecs, nil
	})
	s := &TagVectorStore{}
	if err := s.BuildFromHierarchy(context.Background(), TagHierarchy{L3: []string{"方程"}}); err != nil {
		t.Fatalf("BuildFromHierarchy: %v", err)
	}
	err := s.AddTags(context.Background(), []TagInput{
		{Name: "方程", Level: TagL3}, // 已存在 → 跳过
		{Name: "", Level: TagL1},   // 空名 → 跳过
		{Name: "几何", Level: TagL3}, // 新增
	})
	if err != nil {
		t.Fatalf("AddTags: %v", err)
	}
	if s.Count() != 2 {
		t.Fatalf("Count = %d, want 2", s.Count())
	}
	last := s.tags[1]
	if last.ID != "L3_几何" || last.Name != "几何" || !reflect.DeepEqual(last.Vec, []float64{100}) {
		t.Errorf("新增标签 = %+v", last)
	}
}

func TestAddTagsAllDuplicate(t *testing.T) {
	invoked := false
	withStubEmbedders(t, nil, func(texts []string) ([][]float64, error) {
		invoked = true
		vecs := make([][]float64, len(texts))
		for i := range vecs {
			vecs[i] = []float64{float64(i)}
		}
		return vecs, nil
	})
	s := &TagVectorStore{}
	_ = s.BuildFromHierarchy(context.Background(), TagHierarchy{L1: []string{"数学"}})
	invoked = false // 只观察 AddTags 是否触发嵌入
	if err := s.AddTags(context.Background(), []TagInput{{Name: "数学", Level: TagL1}}); err != nil {
		t.Fatalf("AddTags: %v", err)
	}
	if invoked {
		t.Error("全部重复时应直接返回，不触发嵌入")
	}
}

func TestAddTagsEmbedFailure(t *testing.T) {
	withStubEmbedders(t, nil, func([]string) ([][]float64, error) {
		return nil, errors.New("boom")
	})
	// 直接预置一个标签，避免 setup 也走失败的嵌入桩
	s := &TagVectorStore{tags: []TagEntry{{ID: "L1_数学", Name: "数学", Level: TagL1, Vec: []float64{0}}}}
	if err := s.AddTags(context.Background(), []TagInput{{Name: "几何", Level: TagL3}}); err == nil {
		t.Fatal("嵌入失败应上抛错误")
	}
	if s.Count() != 1 {
		t.Errorf("失败后 Count = %d, want 1（状态不变）", s.Count())
	}
}

func TestSearchByLevel(t *testing.T) {
	s := &TagVectorStore{tags: []TagEntry{
		{ID: "L1_数学", Name: "数学", Level: TagL1, Vec: []float64{1}},
		{ID: "L2_代数", Name: "代数", Level: TagL2, Vec: []float64{1}},
		{ID: "L3_方程", Name: "方程", Level: TagL3, Vec: []float64{1}},
		{ID: "L3_几何", Name: "几何", Level: TagL3, Vec: []float64{0}},
	}}
	cases := []struct {
		name   string
		search func([]float64, int, float64) []TagHit
		want   []TagHit
	}{
		{"L1 只含本层", s.SearchL1, []TagHit{{Name: "数学", Score: 1}}},
		{"L2 只含本层", s.SearchL2, []TagHit{{Name: "代数", Score: 1}}},
		{"L3 阈值过滤", s.SearchL3, []TagHit{{Name: "方程", Score: 1}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.search([]float64{1}, 10, 0.5)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
	// topK 截断 + 零阈值：几何(0 分)放行但排在方程之后
	got := s.SearchL3([]float64{1}, 1, 0)
	if !reflect.DeepEqual(got, []TagHit{{Name: "方程", Score: 1}}) {
		t.Errorf("topK=1 got %+v", got)
	}
}

func TestGetAllTagsOrder(t *testing.T) {
	s := &TagVectorStore{tags: []TagEntry{
		{ID: "L1_a", Name: "a"},
		{ID: "L2_b", Name: "b"},
		{ID: "L3_c", Name: "c"},
	}}
	if got := s.GetAllTags(); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("GetAllTags = %v", got)
	}
}

func TestCollectTagsInto(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []TagEntry // 以 key/level 对表示
	}{
		{
			name: "位置推断层级",
			in:   []string{"a", "b", "c", "d"},
			want: []TagEntry{
				{ID: "L1_a", Level: TagL1, Name: "a"},
				{ID: "L2_b", Level: TagL2, Name: "b"},
				{ID: "L3_c", Level: TagL3, Name: "c"},
				{ID: "L3_d", Level: TagL3, Name: "d"},
			},
		},
		{
			// 空名跳过但数组下标被占用：x 位于 index 1 → L2（与 TS 的
			// `for (let i = 0; ...)` 按原始下标推断层级一致）
			name: "空名占位，层级按下标推断",
			in:   []string{"  ", "x"},
			want: []TagEntry{{ID: "L2_x", Level: TagL2, Name: "x"}},
		},
		{
			name: "trim 生效",
			in:   []string{" x "},
			want: []TagEntry{{ID: "L1_x", Level: TagL1, Name: "x"}},
		},
		{
			name: "同名不同层级是不同键",
			in:   []string{"a", "a"},
			want: []TagEntry{
				{ID: "L1_a", Level: TagL1, Name: "a"},
				{ID: "L2_a", Level: TagL2, Name: "a"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			set := newTagSet()
			collectTagsInto(set, tc.in)
			collectTagsInto(set, tc.in) // 二次收集应幂等（Map 去重）
			got := make([]TagEntry, 0, len(set.order))
			for _, key := range set.order {
				got = append(got, TagEntry{ID: key, Level: set.levels[key], Name: key[3:]})
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
