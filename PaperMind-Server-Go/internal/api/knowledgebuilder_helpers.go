package api

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
)

// ── 纯逻辑助手（无 DB / LLM 依赖，可单测）──────────────────────────

// kbInvalidTagSet 复刻 generateHierarchicalTags / rebuild-all 的 INVALID
// 集合（knowledge-builder.ts:487-497、2599-2609）：LLM 输出的占位值。
var kbInvalidTagSet = map[string]bool{
	"无": true, "未知": true, "未分类": true, "无法识别": true,
	"无法确定": true, "无法分类": true, "其他": true, "其它": true, "未标注": true,
}

// kbL3NewLimit 复刻 L3 新增标签上限（knowledge-builder.ts:500）：
// <3000 字 → 3，<6000 → 4，≥6000 → 5（textLength 为 UTF-16 码元数）。
func kbL3NewLimit(textLength int) int {
	if textLength < 3000 {
		return 3
	}
	if textLength < 6000 {
		return 4
	}
	return 5
}

// kbRecordText 复刻 extractText(record)（:152-158）：content → title →
// name → description，全空返回 ”（TS 的 falsy 逐级下落）。
func kbRecordText(record map[string]any) string {
	for _, key := range []string{"content", "title", "name", "description"} {
		if s, ok := record[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// kbPageMarkerRe 是 TOC 页码标记 `-{1,3}\s*\d+\s*of\s*\d+\s*-{1,3}`
// （knowledge-builder.ts:173），\s 按 JS 字符集展开（Go \s 不含 \u00a0 等）。
var kbPageMarkerRe = regexp.MustCompile(
	`-{1,3}` + kbJSSpacePattern + `*[0-9]+` + kbJSSpacePattern + `*of` +
		kbJSSpacePattern + `*[0-9]+` + kbJSSpacePattern + `*-{1,3}`)

// kbJSSpacePattern 是 JS 正则 \s 的字符类（供上者拼接）。
const kbJSSpacePattern = `[\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]`

// kbStripTOC 剥离目录页（knowledge-builder.ts:164-203）：开头 2000 字内
// 点密度 >5% 视为 TOC——有 ≥3 个页码标记则跳到第 3 个标记之后，否则
// （文本 >4000 字时）硬跳前 3000 字。返回值已 trim（JS trim）。
func kbStripTOC(text string) string {
	if kbUTF16Len(text) < 2000 {
		return text
	}
	firstChunk := kbJSSlice(text, 0, 2000)
	dotRatio := float64(strings.Count(firstChunk, ".")) / float64(kbUTF16Len(firstChunk))
	if dotRatio <= 0.05 {
		return text
	}
	// 页码标记位置（UTF-16 码元下标 = 匹配结束处），对应 markers.push(m.index + m[0].length)
	var markers []int
	total := kbUTF16Len(text)
	for _, m := range kbPageMarkerRe.FindAllStringIndex(text, -1) {
		markers = append(markers, kbUTF16IndexAtByte(text, m[1]))
	}
	if len(markers) >= 3 {
		skipTo := markers[2]
		if skipTo > 500 && skipTo < total-100 {
			trimmed := kbJSTrim(kbJSSlice(text, skipTo, total))
			log.Printf("[stripTOC] dot density %.1f%%, skipped %d chars to page marker 3, remaining: %d",
				dotRatio*100, skipTo, kbUTF16Len(trimmed))
			return trimmed
		}
	}
	if total > 4000 {
		trimmed := kbJSTrim(kbJSSlice(text, 3000, total))
		log.Printf("[stripTOC] dot density %.1f%%, skip-first-3000 fallback, remaining: %d",
			dotRatio*100, kbUTF16Len(trimmed))
		return trimmed
	}
	return text
}

// kbUTF16IndexAtByte 返回 s[:byteIndex] 的 UTF-16 码元长度
// （把正则的字节偏移换算成 JS 的字符串下标）。
func kbUTF16IndexAtByte(s string, byteIndex int) int {
	n := 0
	for i, r := range s {
		if i >= byteIndex {
			break
		}
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// kbCharOverlapRatio 复刻 charOverlapRatio（knowledge-builder.ts:421-432）：
// 两串去空白后字符集合的交集 / 较小集合大小（0-1）。用于把 LLM 输出的
// L1/L2/L3 强制吸附到已有标签（>0.75 视为同一）。JS for-of 按码点迭代，
// Go 按 rune 迭代，语义一致。
func kbCharOverlapRatio(a, b string) float64 {
	aChars := kbStripJSSpace(a)
	bChars := kbStripJSSpace(b)
	if aChars == "" || bChars == "" {
		return 0
	}
	aSet := map[rune]bool{}
	for _, r := range aChars {
		aSet[r] = true
	}
	bSet := map[rune]bool{}
	for _, r := range bChars {
		bSet[r] = true
	}
	shared := 0
	for r := range aSet {
		if bSet[r] {
			shared++
		}
	}
	minLen := len(aSet)
	if len(bSet) < minLen {
		minLen = len(bSet)
	}
	return float64(shared) / float64(minLen)
}

// 垃圾 L3 标签判定的子正则（knowledge-builder.ts:469-476）
var (
	kbGarbageQuestionMark = regexp.MustCompile(`[?？]`)
	kbGarbageQuestionHead = regexp.MustCompile(`^(为什么|如何|怎么|怎样|哪些|什么|何为)`)
	kbGarbageToneTail     = regexp.MustCompile(`(吗|呢|吧|啊)$`)
	kbGarbageFileExt      = regexp.MustCompile(`\.[a-zA-Z0-9]{2,4}$`)
)

// kbIsGarbageL3Tag 复刻 isGarbageL3Tag（issue #18）：章节标签应是简短
// 名词，过滤问句、超长句子和文件名残留（长度按 UTF-16 码元计）。
func kbIsGarbageL3Tag(t string) bool {
	if kbUTF16Len(t) > 20 {
		return true
	}
	if kbGarbageQuestionMark.MatchString(t) {
		return true
	}
	if kbGarbageQuestionHead.MatchString(t) {
		return true
	}
	if kbGarbageToneTail.MatchString(t) {
		return true
	}
	if kbGarbageFileExt.MatchString(t) {
		return true
	}
	return false
}

// kbFilterL3s 复刻 generateHierarchicalTags 尾部的过滤
// （knowledge-builder.ts:690-697）：剔 INVALID、"无法"/"未"开头、与父级
// L2 同名、垃圾标签。
func kbFilterL3s(finalL3s []string, l2 string) []string {
	out := make([]string, 0, len(finalL3s))
	for _, t := range finalL3s {
		if kbInvalidTagSet[t] ||
			strings.HasPrefix(t, "无法") ||
			strings.HasPrefix(t, "未") ||
			t == l2 ||
			kbIsGarbageL3Tag(t) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// kbBuildLogicalPaths 复刻 buildLogicalPaths（knowledge-builder.ts:713-722）：
// 每个 L3 一条 `/{L1}/{L2}/{L3}/` 路径；无 L3 时 `/{L1}/{L2}/`；仅 L1 时
// `/{L1}/`；全空落到 `/未分类/`。
func kbBuildLogicalPaths(l1, l2 string, knowledgePoints []string) []string {
	switch {
	case l1 != "" && l2 != "":
		if len(knowledgePoints) > 0 {
			paths := make([]string, len(knowledgePoints))
			for i, l3 := range knowledgePoints {
				paths[i] = "/" + l1 + "/" + l2 + "/" + l3 + "/"
			}
			return paths
		}
		return []string{"/" + l1 + "/" + l2 + "/"}
	case l1 != "":
		return []string{"/" + l1 + "/"}
	default:
		return []string{"/未分类/"}
	}
}

// kbParseLogicalPathArray 复刻 parseLogicalPathArray（knowledge-builder.ts:733-756）：
// 解析 logical_path 为路径数组；兼容历史双嵌套格式（数组唯一元素仍是 JSON
// 数组字符串，最多解包 3 层）；无法解析返回 ok=false。
func kbParseLogicalPathArray(lp string) ([]string, bool) {
	var arr any
	if err := json.Unmarshal([]byte(lp), &arr); err != nil {
		return nil, false
	}
	for i := 0; i < 3; i++ {
		arrArr, ok := arr.([]any)
		if !ok {
			return nil, false
		}
		if len(arrArr) == 0 {
			return []string{}, true
		}
		first, ok := arrArr[0].(string)
		if !ok || !strings.HasPrefix(kbJSTrim(first), "[") {
			break // 普通路径数组
		}
		var inner any
		if err := json.Unmarshal([]byte(first), &inner); err != nil {
			break // 以 [ 开头但不是 JSON（如 "[重点] 第一章"），按普通路径处理
		}
		if _, ok := inner.([]any); !ok {
			break
		}
		arr = inner
	}
	arrArr, ok := arr.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(arrArr))
	for _, p := range arrArr {
		s := kbJSTrim(kbJSString(p))
		if s != "" {
			out = append(out, s)
		}
	}
	return out, true
}

// kbUserSetLogicalPath 复刻 getUserSetLogicalPath（knowledge-builder.ts:761-773）：
// 上传表单设置的用户路径（解包归一化后的单层 JSON 数组字符串），
// 空串/'/'/'/未分类/'/含"未分类"视为未设置返回 ""。
func kbUserSetLogicalPath(record map[string]any) string {
	lp, _ := record["logical_path"].(string)
	if kbJSTrim(lp) == "" {
		return ""
	}
	paths, ok := kbParseLogicalPathArray(lp)
	if !ok || len(paths) == 0 {
		return ""
	}
	first := paths[0]
	if first == "" || first == "/" || first == "/未分类/" || strings.Contains(first, "未分类") {
		return ""
	}
	normalized := kbJSONStringify(paths)
	if normalized != kbJSTrim(lp) {
		log.Printf("[logical-path] 归一化 logical_path: %s → %s", lp, normalized)
	}
	return normalized
}

// 降级 Papercore 的两步清洗（knowledge-builder.ts:404-414）
var (
	kbDegradedExtRe  = regexp.MustCompile(`\.[^.]+$`) // 去掉扩展名（首个匹配即末段）
	kbDegradedSepRe  = strings.NewReplacer("-", " ", "_", " ")
	kbDegradedFormat = "该文档以公式/图表为主，根据文件名及上下文推断，核心内容定位为：%s。"
)

// kbBuildDegradedPapercore 复刻 buildDegradedPapercore：可读文本不足
// （<30% 或公式/图表密集）时按文件名推断主题描述；fileName 优先于 folderName。
func kbBuildDegradedPapercore(fileName, folderName string) string {
	source := fileName
	if source == "" {
		source = folderName
	}
	if source != "" {
		keyword := kbDegradedExtRe.ReplaceAllString(source, "") // JS replace 非全局：仅首个匹配，$ 锚定等价
		keyword = kbDegradedSepRe.Replace(keyword)
		keyword = kbJSTrim(keyword)
		return fmt.Sprintf(kbDegradedFormat, keyword)
	}
	return "该文档以公式/图表为主，核心主题未识别，建议手动补充摘要。"
}

// kbStringSlice 把 DB 行的 JSON 数组列解为 []string（非数组/nil → nil，
// 元素非字符串时以 JS String() 语义拼入）。
func kbStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, el := range arr {
		out = append(out, kbJSString(el))
	}
	return out
}

// kbFilterEmpty 复刻 [...vals].filter(Boolean)：剔空串（用于
// [L1, L2, ...l3s].filter(Boolean) 的标签拼装）。
func kbFilterEmpty(vals []string) []string {
	out := vals[:0:0]
	for _, v := range vals {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// orEmptyStrings 保证 nil 切片序列化为 [] 而非 null（TS 数组恒为 []）。
func orEmptyStrings(vals []string) []string {
	if vals == nil {
		return []string{}
	}
	return vals
}

// kbContains 报告切片是否含 s（includes 的等价物）。
func kbContains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// kbRecordIDString 把 DB 行的 id（JSON number）转 `${record.id}` 形态
// （5.0 → "5"，用于 graph 的 recordId 拼接）。
func kbRecordIDString(v any) string {
	return kbJSString(v)
}

// kbAdjacentDedup 复刻 consolidateTags 的
// updated.filter((t, i) => t !== updated[i-1])（相邻去重，
// knowledge-builder.ts:2248——与首现去重不同，见 kbFirstOccurrenceDedup）。
func kbAdjacentDedup(tags []string) []string {
	out := make([]string, 0, len(tags))
	for i, t := range tags {
		if i > 0 && t == tags[i-1] {
			continue
		}
		out = append(out, t)
	}
	return out
}

// kbFirstOccurrenceDedup 复刻 l3-consolidate 的
// updated.filter((t, i) => updated.indexOf(t) === i)（首现去重，
// knowledge-builder.ts:2845）。
func kbFirstOccurrenceDedup(tags []string) []string {
	seen := map[string]int{}
	out := make([]string, 0, len(tags))
	for i, t := range tags {
		if first, ok := seen[t]; ok && first != i {
			continue
		}
		if _, ok := seen[t]; !ok {
			seen[t] = i
		}
		out = append(out, t)
	}
	return out
}

// kbReplaceTagInPaths 复刻 paths.map(p => p.replace(`/${from}/`, `/${to}/`))
// （knowledge-builder.ts:2259/2854）：每条路径替换首个 /from/ 段。
func kbReplaceTagInPaths(paths []string, from, to string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = strings.Replace(p, "/"+from+"/", "/"+to+"/", 1)
	}
	return out
}

// kbParsePathsOrLegacy 复刻 rawPath 的解析（:2250-2258、2846-2853）：
// JSON 数组 → 数组；解析失败或非数组 → [rawPath] 单元素兜底。
func kbParsePathsOrLegacy(rawPath string) []string {
	if rawPath == "" {
		rawPath = "[]"
	}
	var parsed any
	if err := json.Unmarshal([]byte(rawPath), &parsed); err != nil {
		return []string{rawPath}
	}
	arr, ok := parsed.([]any)
	if !ok {
		return []string{rawPath}
	}
	out := make([]string, 0, len(arr))
	for _, p := range arr {
		out = append(out, kbJSString(p))
	}
	return out
}
