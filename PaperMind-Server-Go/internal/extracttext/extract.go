// Package extracttext 对应 server/src/utils/extract-text.ts 的导出契约。
//
// TS 支持矩阵（extract-text.ts:1-5）：PDF（mupdf 逐页 + pdf-parse + 视觉 OCR
// 三级兜底）、DOCX、PPTX、XLSX、TXT、MD、CSV；不支持 .doc/.ppt 旧版二进制
// （返回标记文本）与图片 OCR（返回空文本）。
//
// Go 侧实现选型与 TS 差异（详见各文件注释与移植 gaps）：
//   - PDF 文本层：mupdf/pdf-parse → github.com/ledongthuc/pdf（纯 Go、零依赖）
//   - 视觉 OCR（页面栅格化 + 视觉模型）：无纯 Go 方案，未移植（见 pdf.go）
//   - DOCX：mammoth → archive/zip + encoding/xml 按 mammoth raw-text 规则手工解析
//   - PPTX/XLSX：AdmZip + 正则 → archive/zip + regexp（行为逐字对齐）
package extracttext

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// ExtractedContent 对应 extract-text.ts:14-17。
// PageCount 为 0 表示未知页数（TS 中为 undefined，路由侧判空逻辑等价）。
type ExtractedContent struct {
	Text      string `json:"text"`
	PageCount int    `json:"pageCount,omitempty"`
}

// ── 可读性判定（extract-text.ts:20-52）──────────────────────────────────

// jsSpace 对应 JS 正则的 \s 类（[\f\n\r\t\v\u0020\u00a0\u1680\u2000-\u200a
// \u2028\u2029\u202f\u205f\u3000\ufeff]）。Go 的 \s 与 unicode.IsSpace 和它
// 有细微出入（多 \u0085、少 \ufeff），为保证比值口径与 TS 一致单独实现。
func jsSpace(r rune) bool {
	switch r {
	case '\f', '\n', '\r', '\t', '\v', ' ',
		0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// isCJKChar 对应 TS 正则区间 [一-鿿]（U+4E00–U+9FFF，CJK 统一表意文字），
// 为中文课文学术内容专门统计。
func isCJKChar(r rune) bool {
	return r >= 0x4E00 && r <= 0x9FFF
}

// IsReadableText 可读性判定（extract-text.ts:20-40）：
// 过滤扫描件/嵌入字体损坏产生的乱码——CJK 占比 < 3% 时要求 ASCII 字母
// 占比 ≥ 15%（放行纯英文文档），且总体可读字符占比 > 15%。
// 可读字符集 = CJK + 全角标点（U+3000-303F / U+FF00-FFEF）+ ASCII 字母数字
// + JS 空白 + 常见半角标点（与 TS 正则逐字对齐，比值按 rune 计，
// TS 的 .length 是 UTF-16 码元数，对 BMP 文本二者一致）。
func IsReadableText(text string) bool {
	if text == "" || utf8.RuneCountInString(text) < 5 {
		return false
	}

	var total, cjk, asciiLetters, readable int
	for _, r := range text {
		total++
		switch {
		case isCJKChar(r):
			cjk++
			readable++
		case r >= 0x3000 && r <= 0x303F, r >= 0xFF00 && r <= 0xFFEF:
			readable++ // CJK 符号/全角形式
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			asciiLetters++
			readable++
		case r >= '0' && r <= '9':
			readable++
		case jsSpace(r):
			readable++
		default:
			switch r {
			case '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}',
				'-', '+', '=', '_', '"', '\'', '<', '>', '/', '\\',
				'@', '#', '$', '%', '^', '&', '*':
				readable++
			}
		}
	}

	// CJK 占比极低时视为疑似乱码：只有纯英文文档（ASCII 字母达标）才能放行
	if float64(cjk)/float64(total) < 0.03 {
		if float64(asciiLetters)/float64(total) < 0.15 {
			return false
		}
	}
	return float64(readable)/float64(total) > 0.15
}

// LooksLikeBrokenGlyphs 乱码字形检测（extract-text.ts:44-52）：
// 压缩空白后相邻同字符占比 > 15%（且长度 ≥ 30）判定为嵌入字体损坏输出
// （损坏字体会输出 "u u u H H H" 这类同字符连片）。
func LooksLikeBrokenGlyphs(text string) bool {
	var b strings.Builder
	for _, r := range text {
		if !jsSpace(r) {
			b.WriteRune(r)
		}
	}
	compact := []rune(b.String())
	if len(compact) < 30 {
		return false
	}
	repeats := 0
	for i := 1; i < len(compact); i++ {
		if compact[i] == compact[i-1] {
			repeats++
		}
	}
	return float64(repeats)/float64(len(compact)) > 0.15
}

// ── 两级缓存（extract-text.ts:60-99）────────────────────────────────────

// extractCacheEntry 内存缓存条目；键 = 文件路径。
type extractCacheEntry struct {
	mtimeMs float64
	size    int64
	result  ExtractedContent
}

var (
	extractCacheMu sync.Mutex
	extractCache   = map[string]extractCacheEntry{}
	// extractCacheOrder 记录插入顺序，对应 TS Map 的迭代顺序（FIFO 淘汰依据）；
	// 对已存在键重新 set 不改变其位置，与 JS Map 语义一致
	extractCacheOrder []string
)

const extractCacheMax = 200

// extractCacheVersion 缓存版本。TS 为 'v4'；Go 版换了 PDF 提取引擎
// （mupdf/pdf-parse → ledongthuc/pdf），按 TS 注释规则「实现升级时 +1，
// 旧缓存自动作废」升到 v5，避免命中 TS 写入的旧引擎磁盘缓存。
const extractCacheVersion = "v5"

func diskCacheDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	return filepath.Join(cwd, ".cache", "extract")
}

// diskCachePath 对应 extract-text.ts:70-76：sha1("version|path|mtimeMs|size")
// 的十六进制作为文件名。mtimeMs 的字符串化用最短浮点表示（JS 模板字符串
// 渲染 Number 的等价形式）。
func diskCachePath(filePath string, mtimeMs float64, size int64) string {
	key := fmt.Sprintf("%s|%s|%s|%d",
		extractCacheVersion, filePath, strconv.FormatFloat(mtimeMs, 'f', -1, 64), size)
	sum := sha1.Sum([]byte(key))
	return filepath.Join(diskCacheDir(), hex.EncodeToString(sum[:])+".json")
}

// readDiskCache 读磁盘缓存；JSON 损坏/缺失一律视为未命中（TS try/catch 吞错）。
func readDiskCache(filePath string, mtimeMs float64, size int64) (ExtractedContent, bool) {
	raw, err := os.ReadFile(diskCachePath(filePath, mtimeMs, size))
	if err != nil {
		return ExtractedContent{}, false
	}
	var j struct {
		Text      string `json:"text"`
		PageCount int    `json:"pageCount"`
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		return ExtractedContent{}, false
	}
	return ExtractedContent{Text: j.Text, PageCount: j.PageCount}, true
}

// writeDiskCache 落盘磁盘缓存；任何写失败只忽略（TS try/catch 吞错）。
func writeDiskCache(filePath string, mtimeMs float64, size int64, result ExtractedContent) {
	raw, err := json.Marshal(result)
	if err != nil {
		return
	}
	if err := os.MkdirAll(diskCacheDir(), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(diskCachePath(filePath, mtimeMs, size), raw, 0o644)
}

// cacheSet 写内存缓存；达到上限先按插入顺序淘汰最旧一条（TS 的
// `extractCache.keys().next().value` 删除，上限 200）。
func cacheSet(filePath string, mtimeMs float64, size int64, result ExtractedContent) {
	extractCacheMu.Lock()
	defer extractCacheMu.Unlock()
	if _, exists := extractCache[filePath]; !exists {
		if len(extractCacheOrder) >= extractCacheMax {
			oldest := extractCacheOrder[0]
			extractCacheOrder = extractCacheOrder[1:]
			delete(extractCache, oldest)
		}
		extractCacheOrder = append(extractCacheOrder, filePath)
	}
	extractCache[filePath] = extractCacheEntry{mtimeMs: mtimeMs, size: size, result: result}
}

// ── 入口（extract-text.ts:104-140）──────────────────────────────────────

// ExtractText 提取文件文本（带内存 + 磁盘缓存），对应 extract-text.ts:104-140：
//   - 缓存键 = 文件路径 + mtime + size；内存上限 200 条（FIFO 淘汰）
//   - 磁盘缓存落 <cwd>/.cache/extract/，服务重启后仍可命中
//   - stat 失败（文件不存在等）时跳过两级缓存，仍尝试提取（TS 同）
//   - 图片（mimeType image/*）返回空文本 + pageCount 0
//   - TXT/MD/CSV 按 rune 截断 50000 字符（TS 的 slice 按 UTF-16 码元截，
//     BMP 文本二者一致）
//   - .ppt/.doc 旧格式返回「[旧版XX二进制格式，无法自动提取…]」标记文本
//
// TS 侧整体 try/catch 吞掉一切异常返回 {text: ”}（绝不向路由抛错，
// upload 链路依赖空文本来走「图片附件/degraded」处理）；Go 版对齐：
// 错误只打日志（≈ console.error），降级为空文本，第二个返回值恒为 nil。
func ExtractText(filePath, mimeType, fileName string) (ExtractedContent, error) {
	var statMtimeMs float64
	var statSize int64
	haveStat := false
	if fi, err := os.Stat(filePath); err == nil {
		statMtimeMs = float64(fi.ModTime().UnixNano()) / 1e6
		statSize = fi.Size()
		haveStat = true
	}
	if haveStat {
		extractCacheMu.Lock()
		hit, ok := extractCache[filePath]
		extractCacheMu.Unlock()
		if ok && hit.mtimeMs == statMtimeMs && hit.size == statSize {
			return hit.result, nil
		}
		if disk, ok := readDiskCache(filePath, statMtimeMs, statSize); ok {
			cacheSet(filePath, statMtimeMs, statSize, disk)
			return disk, nil
		}
	}
	result := extractTextUncached(filePath, mimeType, fileName)
	if haveStat {
		cacheSet(filePath, statMtimeMs, statSize, result)
		writeDiskCache(filePath, statMtimeMs, statSize, result)
	}
	return result, nil
}

// extractTextUncached 按 mime/扩展名分派（extract-text.ts:142-214），
// 分派顺序与 TS 完全一致（注意 XLSX 在纯文本之后判断）。
// 兜底 recover 对应 TS 最外层 catch：解析库 panic 也降级为空文本。
func extractTextUncached(filePath, mimeType, fileName string) (result ExtractedContent) {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[extractText] Error: %v", e)
			result = ExtractedContent{}
		}
	}()

	// 图片无 OCR：学习纪要图片附件会走到这里，返回空文本由上传层按「图片附件」诚实处理
	if strings.HasPrefix(mimeType, "image/") {
		return ExtractedContent{Text: "", PageCount: 0}
	}

	// PDF
	if mimeType == "application/pdf" || strings.HasSuffix(fileName, ".pdf") {
		return extractPdf(filePath)
	}

	// DOCX
	if mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		strings.HasSuffix(fileName, ".docx") {
		return extractDocx(filePath)
	}

	// PPTX
	if mimeType == "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		strings.HasSuffix(fileName, ".pptx") {
		return extractPptx(filePath)
	}

	// TXT / MD / CSV
	if mimeType == "text/plain" || mimeType == "text/markdown" ||
		strings.HasSuffix(fileName, ".txt") ||
		strings.HasSuffix(fileName, ".md") ||
		strings.HasSuffix(fileName, ".csv") {
		data, err := os.ReadFile(filePath)
		if err != nil {
			log.Printf("[extractText] Error: %v", err)
			return ExtractedContent{}
		}
		text := string(data)
		if r := []rune(text); len(r) > 50000 {
			text = string(r[:50000])
		}
		return ExtractedContent{Text: text}
	}

	// XLSX
	if strings.HasSuffix(fileName, ".xlsx") ||
		mimeType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		return extractXlsx(filePath)
	}

	// .ppt / .doc 旧版二进制格式：无提取实现，返回标记文本供分类链路识别
	// （knowledge-builder 的占位检测会走 degraded 路径，用户看到明确提示而非静默失败）
	if mimeType == "application/vnd.ms-powerpoint" || strings.HasSuffix(fileName, ".ppt") {
		return ExtractedContent{
			Text:      "[旧版PPT二进制格式，无法自动提取，请转存为 .pptx 后重新上传]",
			PageCount: 0,
		}
	}
	if mimeType == "application/msword" || strings.HasSuffix(fileName, ".doc") {
		return ExtractedContent{
			Text:      "[旧版Word二进制格式，无法自动提取，请转存为 .docx 后重新上传]",
			PageCount: 0,
		}
	}

	return ExtractedContent{}
}
