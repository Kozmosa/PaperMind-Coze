package extracttext

import (
	"log"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	pdf "github.com/ledongthuc/pdf"
)

// ── 文本清理（extract-text.ts:216-229）──────────────────────────────────

var (
	// 课件页脚标记，如 "-- 2 of 252 --"（大小写不敏感）
	rePdfFooterMark = regexp.MustCompile(`(?i)--\s*\d+\s*of\s*\d+\s*--`)
	// 行尾空白（换行前的空格/Tab）
	rePdfTrailingSpace = regexp.MustCompile(`[ \t]+\n`)
	// 3 个以上连续换行压成 2 个
	rePdfMultiNewline = regexp.MustCompile(`\n{3,}`)
)

// cleanExtractedText 清理提取文本：CRLF 归一化、页脚标记、行尾空白、
// 多余空行、连续重复页眉行（extract-text.ts:217-229），最后整体 trim。
func cleanExtractedText(text string) string {
	t := strings.ReplaceAll(text, "\r\n", "\n")
	t = rePdfFooterMark.ReplaceAllString(t, "")
	t = rePdfTrailingSpace.ReplaceAllString(t, "\n")
	t = rePdfMultiNewline.ReplaceAllString(t, "\n\n")

	var out []string
	for _, line := range strings.Split(t, "\n") {
		// 与上一行相同且非空白的行视为重复页眉，跳过
		if len(out) > 0 && out[len(out)-1] == line && strings.TrimSpace(line) != "" {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// ── PDF 提取（extract-text.ts:231-394）──────────────────────────────────
//
// TS 是三级兜底：① mupdf 逐页（页间 \f 分隔，乱码页单页视觉 OCR 替换）
// ② pdf-parse 整篇 ③ 视觉 OCR 整篇（扫描件）。
// Go 侧用 ledongthuc/pdf（rsc.io/pdf 血统，纯 Go 零依赖）承担文本层：
//   - ① 的逐页分诊/页间 \f/可读性闸门逐条对齐；单页视觉 OCR 未实现（见
//     visionOcrPage），乱码页置空——等价于 TS 未配置 VISION_API_KEY 时
//     visionOcrPage 首行直接 return '' 的降级路径
//   - ② 无第二引擎可切：用同一解析器把全部页（不做单页可读性过滤）
//     拼接近似 pdf-parse 的整篇 getText；页级解析失败跳过该页继续
//     （TS 侧 pdf-parse 整篇失败会整体抛错回 {text:''}，Go 稍宽容，
//     尽量保住可解析页的内容）
//   - ③ 未实现：纯 Go 生态没有 PDF 页面栅格化方案（pdfcpu 只能抽嵌入
//     图片，go-fitz 需 CGO+原生 mupdf，违反「优先纯 Go」依赖政策），
//     扫描件在 Go 版只能得到空文本——行为差异见移植 gaps

// extractPdf 对应 extract-text.ts:231-267。
func extractPdf(filePath string) ExtractedContent {
	// 第一级：逐页提取 + 单页可读性分诊。同样过可读性/乱码检查：
	// 扫描件在解析器下产出破碎字形，必须放行给（未实现的）视觉兜底
	if perPage, ok := extractPdfPerPage(filePath); ok {
		trimmed := strings.TrimSpace(perPage.Text)
		if utf8.RuneCountInString(trimmed) >= 30 &&
			IsReadableText(perPage.Text) &&
			!LooksLikeBrokenGlyphs(perPage.Text) {
			return perPage
		}
	}

	// 第二级：整篇提取（≈ pdf-parse）
	text, numPages := extractPdfWholeDoc(filePath)
	cleaned := cleanExtractedText(text)
	// 扫描件/乱码：提取为空、过短、不可读或字形破碎 → 视觉模型 OCR 兜底
	if utf8.RuneCountInString(cleaned) < 50 || !IsReadableText(cleaned) || LooksLikeBrokenGlyphs(cleaned) {
		if vision := extractPdfWithVision(filePath); vision.Text != "" {
			pageCount := vision.PageCount
			if pageCount == 0 {
				pageCount = numPages
			}
			return ExtractedContent{Text: vision.Text, PageCount: pageCount}
		}
	}
	return ExtractedContent{Text: cleaned, PageCount: numPages}
}

// openPdfReader 打开 PDF 并构建 ledongthuc/pdf 的 Reader。
func openPdfReader(filePath string) (*pdf.Reader, *os.File, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	r, err := pdf.NewReader(f, fi.Size())
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	return r, f, nil
}

// extractPdfPerPage 逐页分诊提取（extract-text.ts:286-324）：
// 读得动的页免费使用；乱码页本应单页视觉 OCR 替换（TS 的 MAX_OCR_PAGES=20
// 控成本，超限页置空避免乱码参与检索），Go 侧 OCR 未实现、乱码页一律置空。
// 页间用换页符 \f 连接（与视觉 OCR、PPTX 的分页约定一致），供
// 引用页数记录 / 页码匹配 / 逐页预览 消费；拼接后不足 30 字符视为失败。
func extractPdfPerPage(filePath string) (ExtractedContent, bool) {
	r, f, err := openPdfReader(filePath)
	if err != nil {
		return ExtractedContent{}, false
	}
	defer func() { _ = f.Close() }()

	total := r.NumPage()
	if total == 0 {
		return ExtractedContent{}, false
	}
	var pages []string
	for i := 1; i <= total; i++ {
		pt, err := r.Page(i).GetPlainText(nil)
		if err != nil {
			pt = "" // 单页解析失败按乱码页处理（置空）
		}
		if pageReadable(pt) {
			pages = append(pages, pt)
		} else if ocr := visionOcrPage(i); ocr != "" {
			pages = append(pages, ocr)
		} else {
			pages = append(pages, "") // join 前会被 trim+过滤掉
		}
	}
	joined := make([]string, 0, len(pages))
	for _, p := range pages {
		if t := strings.TrimSpace(p); t != "" {
			joined = append(joined, t)
		}
	}
	joinedText := strings.Join(joined, "\f")
	if utf8.RuneCountInString(joinedText) < 30 {
		return ExtractedContent{}, false
	}
	return ExtractedContent{Text: cleanExtractedText(joinedText), PageCount: total}, true
}

// extractPdfWholeDoc 整篇提取（≈ extract-text.ts:245-251 的 pdf-parse
// getText + numpages）：全部页文本按内容流顺序拼接，不做单页可读性过滤。
// 返回 numpages（打开/解析失败时为 0，对应 TS 的 catch → {text:”}）。
func extractPdfWholeDoc(filePath string) (string, int) {
	r, f, err := openPdfReader(filePath)
	if err != nil {
		log.Printf("[extractPdf] Error: %v", err)
		return "", 0
	}
	defer func() { _ = f.Close() }()

	numPages := r.NumPage()
	parts := make([]string, 0, numPages)
	for i := 1; i <= numPages; i++ {
		t, err := r.Page(i).GetPlainText(nil)
		if err != nil {
			continue // 行为取舍：跳过坏页保住其余内容（TS 整篇失败则全空）
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, "\n"), numPages
}

// pageReadable 单页可读性（extract-text.ts:273-282）：
// 中文课件页要求 CJK 占比达标（≥3%）；纯英文页要求至少一半 token 是
// 纯 ASCII 单词（排除嵌入字体损坏产生的 mojibake，如 "üèØ" 混杂页）。
var reAsciiWord = regexp.MustCompile(`^[a-zA-Z][a-zA-Z\-'.]+$`)

func pageReadable(pt string) bool {
	t := strings.TrimSpace(pt)
	if utf8.RuneCountInString(t) < 10 {
		return false
	}
	var total, cjk int
	for _, r := range t {
		total++
		if isCJKChar(r) {
			cjk++
		}
	}
	if float64(cjk)/float64(total) >= 0.03 {
		return true
	}
	// tokens = t.split(/\s+/).filter(含 ASCII 字母)
	tokens := strings.FieldsFunc(t, jsSpace)
	tokens = filterContainsLetter(tokens)
	if len(tokens) == 0 {
		return false
	}
	words := 0
	for _, tok := range tokens {
		if reAsciiWord.MatchString(tok) {
			words++
		}
	}
	return float64(words)/float64(len(tokens)) >= 0.5
}

// filterContainsLetter 保留含至少一个 ASCII 字母的 token（TS 的
// `.filter((x) => /[a-zA-Z]/.test(x))`）。
func filterContainsLetter(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, tok := range tokens {
		for _, r := range tok {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				out = append(out, tok)
				break
			}
		}
	}
	return out
}

// visionOcrPage 对应 TS extract-text.ts:327-375 的单页视觉 OCR：mupdf 把
// 该页渲染成 PNG（1.5x 缩放）交给 OpenAI 兼容视觉端点识别。
// 【未实现/gap】Go 侧没有可用的纯 Go PDF 页面栅格化方案，此函数恒返回
// 空串——等价于 TS 在未配置 VISION_API_KEY 时首行 `if (!VISION_CONFIG.apiKey)
// return ”` 的降级路径。若未来引入栅格化（如 CGO mupdf），配置读取
// internal/config 的 VisionAPIKey/VisionEndpoint/VisionModel 即可接回。
func visionOcrPage(pageIdx int) string {
	_ = pageIdx
	return ""
}

// extractPdfWithVision 对应 TS extract-text.ts:378-394 的扫描件兜底：
// 渲染前 15 页逐页 OCR 后按 \f 拼接。【未实现/gap】同 visionOcrPage，
// 恒返回空文本。
func extractPdfWithVision(filePath string) ExtractedContent {
	_ = filePath
	return ExtractedContent{}
}
