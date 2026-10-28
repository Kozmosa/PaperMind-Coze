package api

import (
	"encoding/json"
	"math"
	"strings"
	"unicode"
)

// ── JS 字符串/数值语义助手（知识构建组专用，kb 前缀）─────────────────
// TS 侧的 s.length / s.slice / s.trim / 正则 \s / Math.round 分别按
// UTF-16 码元、码元下标、Unicode 空白（含 BOM）、JS \s 集、floor(x+0.5)
// 工作；Go 的对应物语义有细微出入。知识构建管线的截断长度（slice(0,2000)
// 等）、点密度比值、坐标取整都依赖这些边界，集中对齐避免各处近似。
// （internal/retrieval/jscompat.go 有同款实现但未导出，且不属本组文件。）

// kbUTF16Len 返回字符串的 UTF-16 码元长度（JS 的 s.length）。
func kbUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// kbJSSlice 复刻 s.slice(start, end)：下标按 UTF-16 码元计，负数从末尾
// 数起，越界钳制。JS 可能截出半个代理对，Go 按 rune 边界截断（差异仅
// 出现在截断点恰逢增补平面字符的极端情况，中文课件文本不受影响）。
func kbJSSlice(s string, start, end int) string {
	n := kbUTF16Len(s)
	if start < 0 {
		start += n
		if start < 0 {
			start = 0
		}
	} else if start > n {
		start = n
	}
	if end < 0 {
		end += n
		if end < 0 {
			end = 0
		}
	} else if end > n {
		end = n
	}
	if start >= end {
		return ""
	}
	var b strings.Builder
	count := 0
	for _, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if count >= start && count+w <= end {
			b.WriteRune(r)
		}
		count += w
		if count >= end {
			break
		}
	}
	return b.String()
}

// kbJSTrim 等价 String.prototype.trim：剥离首尾 JS 空白（含 \uFEFF，
// 不含 \u0085——Go unicode.IsSpace 的两点差异正好相反，逐一修正）。
func kbJSTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		if r == '\uFEFF' {
			return true
		}
		return r != '\u0085' && unicode.IsSpace(r)
	})
}

// kbIsJSRegexSpace 判定 JS 正则 \s 字符集（比 Go 的 \s 多
// \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff）。
func kbIsJSRegexSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// kbStripJSSpace 复刻 s.replace(/\s+/g, ”)：剔除全部 JS 空白。
// （charOverlapRatio / getTopL3sUnderL2 的字符集构造依赖。）
func kbStripJSSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if !kbIsJSRegexSpace(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// kbCollapseJSSpace 复刻 s.replace(/\s+/g, ' ')：空白串压成单个空格。
func kbCollapseJSSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := false
	for _, r := range s {
		if kbIsJSRegexSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
				inSpace = true
			}
			continue
		}
		b.WriteRune(r)
		inSpace = false
	}
	return b.String()
}

// kbJSString 复刻 JS 的 String(x)（parseLogicalPathArray 的 arr.map(String)
// 依赖）：null→"null"、布尔/数字按字面量、数组逗号拼接（元素 null/undefined
// 拼空串）、对象 "[object Object]"。数字的指数表示（1e21）与 JS 有差异，
// 调用方数据（逻辑路径数组）不会出现该量级。
func kbJSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsonNumber(x)
	case []any:
		parts := make([]string, len(x))
		for i, el := range x {
			if el == nil {
				parts[i] = "" // JS [null].toString() 元素空串
			} else {
				parts[i] = kbJSString(el)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsonNumber 用 encoding/json 的数字编码（与 JS 一致的最短表示，
// 供 kbJSString 的数字分支使用）。
func jsonNumber(f float64) string {
	b, err := json.Marshal(f)
	if err != nil {
		return "0"
	}
	return string(b)
}

// kbRound2 复刻 Math.round(x*100)/100（图谱坐标取整）。
// JS Math.round 是 floor(x+0.5)（-0.5 进 0），Go math.Round 是
// half-away-from-zero（-0.5 进 -1），按 JS 语义实现。
func kbRound2(x float64) float64 {
	return math.Floor(x*100+0.5) / 100
}

// kbExtractJSONArray 复刻 c.match(/\[[\s\S]*\]/)：首个 [ 到最后一个 ]
// 的贪婪匹配（L3 标签/归并对的 JSON 数组提取）。
func kbExtractJSONArray(s string) (string, bool) {
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start < 0 || end < start {
		return "", false
	}
	return s[start : end+1], true
}

// kbJSONStringify 复刻 JSON.stringify：输出无 HTML 转义（Go 默认会把
// <>& 转成 \u003c 等，逻辑路径落库串必须与 JS 逐字节一致）。
func kbJSONStringify(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimSuffix(sb.String(), "\n")
}
