package extracttext

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strings"
)

// zipContents 打开 zip（OOXML 即 zip+xml），按归档顺序返回名字匹配
// prefix+suffix 的条目内容（对应 TS 的 AdmZip.getEntries().filter(...) +
// getData().toString('utf-8')）。docx 的 word/document.xml 也用它取
// （prefix/suffix 组合下只会精确命中该文件）。
func zipContents(filePath, prefix, suffix string) ([]string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	// zip.NewReader 需要 io.ReaderAt + 明确的 size（≈ AdmZip(filePath)）
	zr, err := zip.NewReader(f, fi.Size())
	if err != nil {
		return nil, err
	}
	var out []string
	for _, zf := range zr.File {
		if !strings.HasPrefix(zf.Name, prefix) || !strings.HasSuffix(zf.Name, suffix) {
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		out = append(out, string(data))
	}
	return out, nil
}

// ── DOCX（extract-text.ts:396-404，mammoth.extractRawText）─────────────

// wmlNamespace 是 wordprocessingml 主命名空间；编码器把带声明前缀的元素
// 解析成 Space=完整 URI。另接受空 Space / "w" 前缀兜底未声明命名空间的
// 生成器产物（mammoth 走语义树不受此影响，行为取舍见函数注释）。
const wmlNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

func isWElement(name xml.Name, local string) bool {
	if name.Local != local {
		return false
	}
	return name.Space == wmlNamespace || name.Space == "" || name.Space == "w"
}

// extractDocx 对应 TS 的 mammoth.extractRawText({ path })。
// Go 不引 mammoth，而是按其 raw-text 映射规则（mammoth.js lib/raw-text.js）
// 手工解 word/document.xml：文本节点原样输出、w:tab → \t、每个段落（w:p）
// 结束补 \n\n；w:br/w:cr 及未识别元素在 mammoth 原始文本里不产生字符。
// mammoth 同样只处理主文档体（不含页眉/页脚/脚注）。
//
// 【行为取舍/gap】mammoth 基于语义文档树会跳过部分容器（AlternateContent
// 的 Fallback 支路等）；Go 版按 XML 序遍历全部 w:t，理论上取到的是超集
// （可能包含文本框、图形内文字）。对「取正文做笔记素材」的用途方向一致。
func extractDocx(filePath string) ExtractedContent {
	contents, err := zipContents(filePath, "word/document.xml", ".xml")
	if err != nil {
		log.Printf("[extractDocx] Error: %v", err)
		return ExtractedContent{}
	}
	if len(contents) == 0 {
		log.Printf("[extractDocx] Error: word/document.xml not found in %s", filePath)
		return ExtractedContent{}
	}
	text, err := docxXMLToText(strings.NewReader(contents[0]))
	if err != nil {
		log.Printf("[extractDocx] Error: %v", err)
		return ExtractedContent{}
	}
	return ExtractedContent{Text: text}
}

// docxXMLToText 按 mammoth raw-text 规则把 document.xml 转纯文本。
// XML 实体由 encoding/xml 自动解码（mammoth 同）。
func docxXMLToText(r io.Reader) (string, error) {
	dec := xml.NewDecoder(r)
	var b strings.Builder
	inWT := 0 // 当前是否位于 w:t 元素内（嵌套计数防御异常 XML）
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("parse document.xml: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch {
			case isWElement(t.Name, "t"):
				inWT++
			case isWElement(t.Name, "tab"):
				b.WriteString("\t")
			case isWElement(t.Name, "p"):
				// 段落开始无需动作，结束统一补 \n\n
			}
		case xml.EndElement:
			switch {
			case isWElement(t.Name, "t"):
				inWT--
			case isWElement(t.Name, "p"):
				b.WriteString("\n\n")
			}
		case xml.CharData:
			if inWT > 0 {
				b.Write(t)
			}
		}
	}
	return b.String(), nil
}

// ── PPTX（extract-text.ts:406-430）──────────────────────────────────────

// PPT 幻灯片文本运行节点 <a:t>…</a:t>（含转义实体，TS 不做反转义，保持一致）
var rePptxTextRun = regexp.MustCompile(`<a:t>([^<]*)</a:t>`)

// extractPptx 枚举 ppt/slides/slide*.xml，逐 slide 抓 <a:t> 文本、空格拼接；
// 用换页符 \f 连接各页幻灯片，file-content 路由可按 \f 拆出逐页文本
// （与 PDF 分页同路径）。pageCount = 命中的 slide 条目数（含空页，与 TS 一致）。
func extractPptx(filePath string) ExtractedContent {
	slides, err := zipContents(filePath, "ppt/slides/slide", ".xml")
	if err != nil {
		log.Printf("[extractPptx] Error: %v", err)
		return ExtractedContent{}
	}
	var texts []string
	for _, content := range slides {
		matches := rePptxTextRun.FindAllString(content, -1)
		parts := make([]string, 0, len(matches))
		for _, m := range matches {
			// TS：m.replace(/<\/?a:t>/g, '') 去掉首尾标签后 join(' ')
			parts = append(parts, strings.ReplaceAll(strings.ReplaceAll(m, "</a:t>", ""), "<a:t>", ""))
		}
		slideText := strings.TrimSpace(strings.Join(parts, " "))
		if slideText != "" {
			texts = append(texts, slideText)
		}
	}
	return ExtractedContent{Text: strings.Join(texts, "\f"), PageCount: len(slides)}
}

// ── XLSX（extract-text.ts:432-455）──────────────────────────────────────

// 单元格 <c r="A1" …>…<v>值</v>：只抓带坐标且含 <v> 的单元格
// （共享字符串 sharedStrings 不解析——TS 同样不解析，属原样保留的粗糙实现）
var reXlsxCell = regexp.MustCompile(`<c[^>]*r="([A-Z]+\d+)"[^>]*>.*?<v>([^<]*)</v>`)

// 通用去标签（TS 的 m.replace(/<[^>]*>/g, ' ')）：单元格整段匹配后剥掉
// 剩余标签只留值（坐标在标签内部，随标签一起被剥掉）
var reStripTags = regexp.MustCompile(`<[^>]*>`)

// extractXlsx 枚举 xl/worksheets/sheet*.xml，逐 sheet 抓单元格值、空格拼接，
// sheet 间用 \n 连接；pageCount = 命中的 sheet 条目数。
func extractXlsx(filePath string) ExtractedContent {
	sheets, err := zipContents(filePath, "xl/worksheets/sheet", ".xml")
	if err != nil {
		log.Printf("[extractXlsx] Error: %v", err)
		return ExtractedContent{}
	}
	var texts []string
	for _, content := range sheets {
		matches := reXlsxCell.FindAllString(content, -1)
		parts := make([]string, 0, len(matches))
		for _, m := range matches {
			parts = append(parts, reStripTags.ReplaceAllString(m, " "))
		}
		sheetText := strings.TrimSpace(strings.Join(parts, " "))
		if sheetText != "" {
			texts = append(texts, sheetText)
		}
	}
	return ExtractedContent{Text: strings.Join(texts, "\n"), PageCount: len(sheets)}
}
