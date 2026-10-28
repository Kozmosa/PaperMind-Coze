package retrieval

import (
	"strings"
	"unicode"
)

// jscompat.go — 复刻 JS 字符串语义的小工具。
//
// TS 侧的 s.length / s.trim() / 正则 \s 分别按 UTF-16 码元、Unicode 空白
// （含 BOM）、JS 正则空白集工作；Go 的 len / strings.TrimSpace /
// unicode.IsSpace 与之有细微出入。检索分块边界、缓存键指纹、封面识别
// 都依赖这些边界值，这里集中对齐，避免各处自行近似。

// trimJS 等价 String.prototype.trim：剥离首尾 JS 空白（含 \uFEFF）。
func trimJS(s string) string {
	return strings.TrimFunc(s, isJSWhitespace)
}

// isJSWhitespace 判定 JS 的 \s 字符集：与 Go 的 unicode.IsSpace 相比
// 多 \uFEFF（BOM）、少 \u0085（NEL）。
func isJSWhitespace(r rune) bool {
	if r == '\uFEFF' {
		return true
	}
	return r != '\u0085' && unicode.IsSpace(r)
}

// utf16Len 返回字符串的 UTF-16 码元长度（即 JS 的 s.length）：
// BMP 内字符 1 码元，增补平面（emoji 等）2 码元。
// 分块长度与缓存键指纹（`${key}::${fileText.length}`）都以它为准。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// truncateRunes 按 JS 的 str.slice(0, n) 语义截断：以 UTF-16 码元计数，
// 且不会把一个增补平面字符（占 2 码元）拦腰截半。
func truncateRunes(s string, n int) string {
	if utf16Len(s) <= n {
		return s
	}
	var b strings.Builder
	count := 0
	for _, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if count+w > n {
			break
		}
		b.WriteRune(r)
		count += w
	}
	return b.String()
}
