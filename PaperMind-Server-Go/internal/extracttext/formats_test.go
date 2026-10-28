package extracttext

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// zipEntry 保持插入顺序（zip 中心目录顺序 = 提取顺序，对应 AdmZip.getEntries）。
type zipEntry struct {
	name    string
	content string
}

// writeTempZip 在临时目录生成一个 zip 文件，条目按给定顺序写入。
func writeTempZip(t *testing.T, fileName string, entries []zipEntry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), fileName)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	zw := zip.NewWriter(f)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// buildTestPDF 生成一个经典 xref 表结构的最小 PDF（Helvetica 无 ToUnicode，
// ASCII 经 pdfDocEncoding 恒等映射），每页一条 Tj 文本，供端到端提取测试。
func buildTestPDF(pageTexts []string) []byte {
	var buf bytes.Buffer
	offsets := make([]int, 0, 8) // offsets[i] = 第 i+1 号对象的字节偏移
	writeObj := func(body string) {
		objNum := len(offsets) + 1
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", objNum, body)
	}

	buf.WriteString("%PDF-1.4\n")
	writeObj("<< /Type /Catalog /Pages 2 0 R >>")

	n := len(pageTexts)
	kids := make([]string, n)
	for i := range kids {
		kids[i] = fmt.Sprintf("%d 0 R", 3+i)
	}
	writeObj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), n))

	for i := range pageTexts {
		writeObj(fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>",
			3+n+i, 3+2*n))
	}
	for _, text := range pageTexts {
		content := fmt.Sprintf("BT /F1 12 Tf 72 720 Td (%s) Tj ET", text)
		writeObj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}
	writeObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

	xrefOffset := buf.Len()
	total := 3 + 2*n
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", total+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", total+1, xrefOffset)
	return buf.Bytes()
}

func writeTempPDF(t *testing.T, pageTexts []string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "doc.pdf")
	if err := os.WriteFile(path, buildTestPDF(pageTexts), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// ── PDF：第一级逐页提取（extract-text.ts:286-324 + 231-243）────────────

func TestExtractTextPdfPerPageTier(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := writeTempPDF(t, []string{
		"Hello Page One First Content",
		"Hello Page Two Second Content",
	})
	got, err := ExtractText(path, "application/pdf", "doc.pdf")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	wantText := "Hello Page One First Content\fHello Page Two Second Content"
	if got.Text != wantText {
		t.Errorf("Text = %q, want %q", got.Text, wantText)
	}
	if got.PageCount != 2 {
		t.Errorf("PageCount = %d, want 2", got.PageCount)
	}
}

// ── PDF：逐页拼接不足 30 字符时落到第二级整篇提取（extract-text.ts:253-262）──

func TestExtractTextPdfWholeDocTier(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := writeTempPDF(t, []string{"Hi"})
	got, err := ExtractText(path, "application/pdf", "small.pdf")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got.Text != "Hi" {
		t.Errorf("Text = %q, want \"Hi\"（整篇清洗后）", got.Text)
	}
	if got.PageCount != 1 {
		t.Errorf("PageCount = %d, want 1", got.PageCount)
	}
}

// ── PDF：按扩展名兜底识别 + 损坏文件降级空文本（TS catch → {text:''}）───

func TestExtractTextPdfBrokenAndByExtension(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	t.Run("按扩展名识别", func(t *testing.T) {
		path := writeTempPDF(t, []string{"Extension Based Detection Works Fine"})
		got, err := ExtractText(path, "", "doc.pdf")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if !strings.Contains(got.Text, "Extension Based") {
			t.Errorf("Text = %q, want 包含正文", got.Text)
		}
	})

	t.Run("损坏文件返回空文本", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "broken.pdf")
		if err := os.WriteFile(path, []byte("this is not a pdf at all"), 0o644); err != nil {
			t.Fatal(err)
		}
		got, err := ExtractText(path, "application/pdf", "broken.pdf")
		if err != nil {
			t.Fatalf("err = %v, want nil（TS 吞错语义）", err)
		}
		if got.Text != "" || got.PageCount != 0 {
			t.Errorf("got %+v, want 空文本", got)
		}
	})
}

// ── DOCX（extract-text.ts:396-404，mammoth raw-text 规则）──────────────

func TestExtractTextDocx(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>制表后</w:t></w:r></w:p>
<w:p><w:r><w:t>Second &amp; entity</w:t></w:r></w:p>
</w:body></w:document>`
	path := writeTempZip(t, "note.docx", []zipEntry{
		{"[Content_Types].xml", "<Types/>"},
		{"word/document.xml", doc},
	})
	got, err := ExtractText(path, "", "note.docx")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	// mammoth 规则：文本原样 + tab→\t + 每段落结尾补 \n\n；实体解码
	want := "第一段\t制表后\n\nSecond & entity\n\n"
	if got.Text != want {
		t.Errorf("Text = %q, want %q", got.Text, want)
	}
	if got.PageCount != 0 {
		t.Errorf("PageCount = %d, want 0（mammoth 不给页数）", got.PageCount)
	}
}

func TestExtractTextDocxMissingDocument(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := writeTempZip(t, "bad.docx", []zipEntry{{"unrelated.xml", "<x/>"}})
	got, err := ExtractText(path, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "bad.docx")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got.Text != "" {
		t.Errorf("Text = %q, want \"\"", got.Text)
	}
}

// ── PPTX（extract-text.ts:406-430）──────────────────────────────────────

func TestExtractTextPptx(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := writeTempZip(t, "slides.pptx", []zipEntry{
		// 干扰项：rels 与母版不应计入
		{"ppt/slides/_rels/slide1.xml.rels", "<Relationships/>"},
		{"ppt/slideMasters/slideMaster1.xml", "<a:t>master 不应被抓取，因为前缀不匹配 slides/slide</a:t>"},
		{"ppt/slides/slide1.xml", `<p:sld><p:spTree><a:r><a:t>Hello </a:t></a:r><a:r><a:t>World</a:t></a:r></p:spTree></p:sld>`},
		{"ppt/slides/slide2.xml", `<a:t>第二页要点</a:t>`},
		{"ppt/slides/slide3.xml", `<a:t></a:t>`},
	})
	got, err := ExtractText(path, "", "slides.pptx")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	// 每页 <a:t> 去标签后以空格 join 再 trim；页间 \f 连接
	want := "Hello  World\f第二页要点"
	if got.Text != want {
		t.Errorf("Text = %q, want %q", got.Text, want)
	}
	if got.PageCount != 3 {
		t.Errorf("PageCount = %d, want 3（含空页，按条目数）", got.PageCount)
	}
}

// ── XLSX（extract-text.ts:432-455）──────────────────────────────────────

func TestExtractTextXlsx(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := writeTempZip(t, "data.xlsx", []zipEntry{
		{"xl/worksheets/sheet1.xml", `<row><c r="A1"><v>42</v></c><c r="B1" t="s"><v>0</v></c></row>`},
		{"xl/worksheets/sheet2.xml", `<row><c r="A2"><v>hello</v></c></row>`},
		// 干扰项：无 r 属性的单元格不匹配（TS 同）
		{"xl/worksheets/sheet3.xml", `<row><c><v>ignored</v></c></row>`},
	})
	got, err := ExtractText(path, "", "data.xlsx")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	// 匹配段剥标签后以空格 join 再 trim；sheet 间 \n 连接；共享字符串不解析（TS 同）。
	// 正则匹配段止于 </v>（含 3 个标签：<c …>、<v>、</v>）→ "  42 " 与 "  0 "，
	// join 后 42 与 0 之间共 4 个空格（与 TS 逐字符一致）
	want := "42" + strings.Repeat(" ", 4) + "0\nhello"
	if got.Text != want {
		t.Errorf("Text = %q, want %q", got.Text, want)
	}
	if got.PageCount != 3 {
		t.Errorf("PageCount = %d, want 3", got.PageCount)
	}
}
