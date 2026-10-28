package extracttext

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// resetCacheForTest 清空内存缓存（磁盘缓存随 t.Chdir 落在临时目录里）。
func resetCacheForTest() {
	extractCacheMu.Lock()
	extractCache = map[string]extractCacheEntry{}
	extractCacheOrder = nil
	extractCacheMu.Unlock()
}

// ── IsReadableText（extract-text.ts:20-40）──────────────────────────────

func TestIsReadableText(t *testing.T) {
	cases := []struct {
		name string
		text string
		want bool
	}{
		{"空串", "", false},
		{"过短", "abc", false},
		{"纯中文", "这是一个足够长的中文句子，可以判定为可读文本", true},
		{"中英混排", "知识图谱 Knowledge Graph 是结构化语义库", true},
		{"纯英文长句", "The quick brown fox jumps over the lazy dog", true},
		{"公式为主字母过少", "x = 3.14 / 2.718 + 1", false},
		{"纯数字", "1234 5678 9012 3456", false},
		{"mojibake 无字母", "üèØ üèØ üèØ üèØ üèØ", false},
		{"CJK 全角标点计入可读", "中文，内容。合格！", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsReadableText(tc.text); got != tc.want {
				t.Errorf("IsReadableText(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// ── LooksLikeBrokenGlyphs（extract-text.ts:44-52）───────────────────────

func TestLooksLikeBrokenGlyphs(t *testing.T) {
	cases := []struct {
		name string
		text string
		want bool
	}{
		{"过短", "uuuHHHuuuHHH", false},
		{"三连重复碎片", strings.Repeat("uuu HHH ", 6), true},
		{"正常中文", "知识图谱是一种结构化的语义知识库，描述概念及其相互关系。", false},
		{"正常英文", "The quick brown fox jumps over the lazy dog again and again", false},
		{"空串", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := LooksLikeBrokenGlyphs(tc.text); got != tc.want {
				t.Errorf("LooksLikeBrokenGlyphs(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// ── pageReadable（extract-text.ts:273-282）──────────────────────────────

func TestPageReadable(t *testing.T) {
	cases := []struct {
		name string
		text string
		want bool
	}{
		{"过短", "short", false},
		{"恰好十个字符", "short page", true}, // trim 后长度 10，不再判短
		{"中文页", "这是一个中文测试页面，包含足够多的汉字内容用于占比判断。", true},
		{"英文单词页", "The cat sat on the mat and ran to the dog for fun", true},
		{"mojibake 页", strings.Repeat("üèØ ", 10), false},
		{"数字页混一个单词", "1234 5678 9012 ab", true}, // 1/1 token 合格，TS 同样放行
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pageReadable(tc.text); got != tc.want {
				t.Errorf("pageReadable(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// ── cleanExtractedText（extract-text.ts:217-229）────────────────────────

func TestCleanExtractedText(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"页脚标记+CRLF", "-- 2 of 252 --\r\n正文内容", "正文内容"},
		{"页脚大小写不敏感", "prefix\n-- 3 OF 10 --\nsuffix", "prefix\n\nsuffix"}, // 标记删除后残留空行（TS 同）
		{"三个以上空行折叠", "line1\n\n\n\nline2", "line1\n\nline2"},
		{"连续重复行去重", "页眉\n页眉\n正文", "页眉\n正文"},
		{"空白行重复不去除", "a\n\n\nb", "a\n\nb"},
		{"行尾空白", "行尾空白   \n下一行", "行尾空白\n下一行"},
		{"整体 trim", "  \n a \n ", "a"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cleanExtractedText(tc.in); got != tc.want {
				t.Errorf("cleanExtractedText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// ── 分派逻辑（extract-text.ts:142-214）──────────────────────────────────

func TestExtractTextImageReturnsEmpty(t *testing.T) {
	resetCacheForTest()
	// 图片不落盘也应直接返回空文本（mimeType 优先判断，不触碰文件系统）
	got, err := ExtractText("nonexistent.png", "image/png", "photo.png")
	if err != nil {
		t.Fatalf("err = %v, want nil（TS 吞错语义）", err)
	}
	if got.Text != "" || got.PageCount != 0 {
		t.Errorf("got %+v, want {Text:\"\" PageCount:0}", got)
	}
}

func TestExtractTextOldBinaryMarkers(t *testing.T) {
	resetCacheForTest()
	cases := []struct {
		name     string
		mime     string
		fileName string
		want     string
	}{
		{"ppt 扩展名", "", "lecture.ppt", "[旧版PPT二进制格式，无法自动提取，请转存为 .pptx 后重新上传]"},
		{"ppt mime", "application/vnd.ms-powerpoint", "lecture.bin", "[旧版PPT二进制格式，无法自动提取，请转存为 .pptx 后重新上传]"},
		{"doc 扩展名", "", "paper.doc", "[旧版Word二进制格式，无法自动提取，请转存为 .docx 后重新上传]"},
		{"doc mime", "application/msword", "paper.bin", "[旧版Word二进制格式，无法自动提取，请转存为 .docx 后重新上传]"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ExtractText(tc.fileName, tc.mime, tc.fileName)
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if got.Text != tc.want || got.PageCount != 0 {
				t.Errorf("got %+v, want Text=%q PageCount=0", got, tc.want)
			}
		})
	}
}

func TestExtractTextUnknownFallsBackToEmpty(t *testing.T) {
	resetCacheForTest()
	got, err := ExtractText("whatever.bin", "application/octet-stream", "whatever.bin")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got.Text != "" {
		t.Errorf("Text = %q, want \"\"", got.Text)
	}
}

func TestExtractTextPlainText(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	cases := []struct {
		name     string
		mime     string
		fileName string
		content  string
	}{
		{"txt 按 mime", "text/plain", "a.dat", "hello plain text"},
		{"md 按扩展名", "", "note.md", "# 标题\n\n正文"},
		{"csv 按扩展名", "", "data.csv", "a,b,c\n1,2,3"},
		{"markdown mime", "text/markdown", "b.dat", "markdown by mime"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.fileName)
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := ExtractText(path, tc.mime, tc.fileName)
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if got.Text != tc.content {
				t.Errorf("Text = %q, want %q", got.Text, tc.content)
			}
			if got.PageCount != 0 {
				t.Errorf("PageCount = %d, want 0（TS 不返回该字段）", got.PageCount)
			}
		})
	}
}

func TestExtractTextPlainTextTruncation(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	// TS slice(0, 50000) 按 UTF-16 码元截断；BMP 文本等价于按 rune 截 50000
	longASCII := strings.Repeat("a", 50010) + "TAIL"
	longCJK := strings.Repeat("知", 50010) + "尾"

	for name, content := range map[string]string{"ascii": longASCII, "cjk": longCJK} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name+".txt")
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := ExtractText(path, "text/plain", name+".txt")
			if err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if n := utf8.RuneCountInString(got.Text); n != 50000 {
				t.Errorf("rune len = %d, want 50000", n)
			}
			if strings.Contains(got.Text, "TAIL") || strings.Contains(got.Text, "尾") {
				t.Errorf("超限尾部未被截断")
			}
		})
	}
}

func TestExtractTextMissingFileDegradesToEmpty(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())
	// stat 失败 → 跳过缓存 → 读文件失败 → 吞错返回空文本（TS catch 语义）
	got, err := ExtractText("no-such-file.txt", "text/plain", "no-such-file.txt")
	if err != nil {
		t.Fatalf("err = %v, want nil（对齐 TS 永不抛错）", err)
	}
	if got.Text != "" {
		t.Errorf("Text = %q, want \"\"", got.Text)
	}
}

// ── 两级缓存（extract-text.ts:60-140）──────────────────────────────────

func TestExtractTextDiskCacheRoundTrip(t *testing.T) {
	resetCacheForTest()
	t.Chdir(t.TempDir())

	path := filepath.Join(t.TempDir(), "cached.txt")
	if err := os.WriteFile(path, []byte("first version"), 0o644); err != nil {
		t.Fatal(err)
	}
	got1, err := ExtractText(path, "text/plain", "cached.txt")
	if err != nil || got1.Text != "first version" {
		t.Fatalf("first call = %+v, err=%v", got1, err)
	}

	// 磁盘缓存应已落盘，且 JSON 形状与 TS 一致（pageCount 省略）
	files, _ := filepath.Glob(filepath.Join(diskCacheDir(), "*.json"))
	if len(files) != 1 {
		t.Fatalf("disk cache files = %v, want 1", files)
	}
	raw, _ := os.ReadFile(files[0])
	if want := `{"text":"first version"}`; string(raw) != want {
		t.Errorf("cache json = %s, want %s", raw, want)
	}

	// 清内存缓存后仍应命中磁盘缓存
	resetCacheForTest()
	got2, _ := ExtractText(path, "text/plain", "cached.txt")
	if got2.Text != "first version" {
		t.Errorf("disk cache miss: %q", got2.Text)
	}

	// 文件变化（size 变）→ 缓存失效重提取
	if err := os.WriteFile(path, []byte("second version!"), 0o644); err != nil {
		t.Fatal(err)
	}
	got3, _ := ExtractText(path, "text/plain", "cached.txt")
	if got3.Text != "second version!" {
		t.Errorf("stale cache: %q", got3.Text)
	}
}

func TestCacheSetFIFOEviction(t *testing.T) {
	resetCacheForTest()
	// 超过 200 条时按插入顺序淘汰最旧的（TS keys().next() 语义）
	keys := make([]string, 205)
	for i := range keys {
		keys[i] = "file" + strings.Repeat("x", 10) + string(rune('a'+i/26)) + string(rune('a'+i%26))
		cacheSet(keys[i], 1.0, int64(i), ExtractedContent{Text: "v"})
	}
	extractCacheMu.Lock()
	defer extractCacheMu.Unlock()
	if len(extractCache) != 200 || len(extractCacheOrder) != 200 {
		t.Fatalf("cache size = %d/%d, want 200/200", len(extractCache), len(extractCacheOrder))
	}
	// 前 5 个键（aa..ae）应被淘汰，队首变成第 6 个插入的键
	if _, exists := extractCache[keys[0]]; exists {
		t.Errorf("oldest key %q should be evicted", keys[0])
	}
	if got := extractCacheOrder[0]; got != keys[5] {
		t.Errorf("order head = %q, want %q", got, keys[5])
	}
}
