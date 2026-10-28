package retrieval

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

// withStubEmbedders 替换包级嵌入入口并在测试结束后恢复；传 nil 的入口
// 会被替换成“必定失败”的桩，防止测试意外触网。
func withStubEmbedders(t *testing.T, one func(string) ([]float64, error), many func([]string) ([][]float64, error)) {
	t.Helper()
	if one == nil {
		one = func(string) ([]float64, error) { return nil, errors.New("embedOne: 测试桩未提供") }
	}
	if many == nil {
		many = func([]string) ([][]float64, error) { return nil, errors.New("embedMany: 测试桩未提供") }
	}
	oldOne, oldMany := embedOne, embedMany
	embedOne, embedMany = one, many
	t.Cleanup(func() { embedOne, embedMany = oldOne, oldMany })
}

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		in   []float64
		want []float64
	}{
		{"3-4-5 三角", []float64{3, 4}, []float64{0.6, 0.8}},
		{"已归一化", []float64{1, 0}, []float64{1, 0}},
		{"零向量原样返回", []float64{0, 0, 0}, []float64{0, 0, 0}},
		{"负分量", []float64{-3, 4}, []float64{-0.6, 0.8}},
		{"单分量", []float64{5}, []float64{1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalize(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("长度不符：got %d want %d", len(got), len(tc.want))
			}
			for i := range got {
				if math.Abs(got[i]-tc.want[i]) > 1e-12 {
					t.Errorf("分量 %d：got %v want %v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestCosineSimilarity(t *testing.T) {
	cases := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"同向", []float64{1, 0}, []float64{1, 0}, 1},
		{"正交", []float64{1, 0}, []float64{0, 1}, 0},
		{"缩放不变", []float64{1, 0}, []float64{0.5, 0}, 0.5},
		{"反向", []float64{1, 0}, []float64{-1, 0}, -1},
		{"三维", []float64{1, 2, 3}, []float64{1, 2, 3}, 14},
		{"空向量（TS 为 NaN，Go 为 0）", []float64{1, 0}, nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CosineSimilarity(tc.a, tc.b); math.Abs(got-tc.want) > 1e-12 {
				t.Errorf("CosineSimilarity = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFindTopK(t *testing.T) {
	cands := []Candidate{
		{ID: "a", Name: "甲", Vec: []float64{1, 0}},
		{ID: "b", Name: "乙", Vec: []float64{0, 1}},
		{ID: "c", Name: "丙", Vec: []float64{0.5, 0.5}},
		{ID: "d", Name: "丁", Vec: []float64{-1, 0}},
		{ID: "e", Name: "戊", Vec: []float64{1, 0}}, // 与 a 同分，验证稳定排序
	}
	cases := []struct {
		name      string
		k         int
		threshold float64
		wantIDs   []string
	}{
		{"阈值过滤+降序", 10, 0.3, []string{"a", "e", "c"}},
		{"topK 截断", 1, 0.3, []string{"a"}},
		{"k=0 返回空", 0, 0.3, []string{}},
		{"阈值全过滤", 10, 0.9, []string{"a", "e"}},
		{"零阈值仍过滤负分", 10, 0, []string{"a", "e", "c", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hits := FindTopK([]float64{1, 0}, cands, tc.k, tc.threshold)
			gotIDs := make([]string, 0, len(hits))
			for _, h := range hits {
				gotIDs = append(gotIDs, h.ID)
			}
			if len(gotIDs) == 0 && len(tc.wantIDs) == 0 {
				return
			}
			if !reflect.DeepEqual(gotIDs, tc.wantIDs) {
				t.Errorf("FindTopK ids = %v, want %v", gotIDs, tc.wantIDs)
			}
		})
	}
}

func TestSanitizeEmbedInput(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", " "},              // 空文本嵌入单个空格
		{"   ", " "},           // 纯空白
		{"  hi  ", "hi"},       // 首尾空白
		{"\u3000x\uFEFF", "x"}, // 全角空格 + BOM（JS trim 范围）
		{"a\nb", "a\nb"},       // 内部空白保留
	}
	for _, tc := range cases {
		if got := sanitizeEmbedInput(tc.in); got != tc.want {
			t.Errorf("sanitizeEmbedInput(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestUtf16Len(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"中文", 2},  // BMP 内 1 码元/字符，与 rune 数一致
		{"😀", 2},   // 增补平面 2 码元
		{"a中😀", 4}, // 1 + 1 + 2
	}
	for _, tc := range cases {
		if got := utf16Len(tc.in); got != tc.want {
			t.Errorf("utf16Len(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
