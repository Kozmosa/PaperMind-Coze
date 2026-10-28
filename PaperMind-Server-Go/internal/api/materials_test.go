package api

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"regexp"
	"strings"
	"testing"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
)

// 本文件只覆盖纯逻辑函数与不触达数据库/网络/磁盘的请求校验分支
//（要求：不写需要网络、数据库或真实上传文件的测试）。
// 上传的 multipart 用例均在内存构造，且都命中「落盘前」的拒绝路径。

// ── encodeURIComponent（materials.ts:222-224 viewUrl 拼接）─────────

func TestJSEncodeURIComponent(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"abc123-_.~", "abc123-_.~"},
		{"!'()*", "!'()*"}, // JS 不转义 ! ' ( ) * 与 ~
		{"a b", "a%20b"},   // 空格 → %20（非 +）
		{"a+b", "a%2Bb"},   // '+' 要转义（与 QueryEscape 不同）
		{"a&b=c", "a%26b%3Dc"},
		{"a/b", "a%2Fb"},
		{"中.pdf", "%E4%B8%AD.pdf"},
		{"学习 资料", "%E5%AD%A6%E4%B9%A0%20%E8%B5%84%E6%96%99"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := jsEncodeURIComponent(tt.in); got != tt.want {
				t.Fatalf("jsEncodeURIComponent(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// ── Node path 语义（upload.ts:29-35、materials.ts:167/222）─────────

func TestPathBasename(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"a/b.txt", "b.txt"},
		{`a\b.txt`, "b.txt"}, // Node win32 同时认 \
		{"x.txt", "x.txt"},
		{"a/b/", ""},
		{"", ""},
		{"/", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := pathBasename(tt.in); got != tt.want {
				t.Fatalf("pathBasename(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestJSExtname(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"file.pdf", ".pdf"},
		{"a.tar.gz", ".gz"},
		{".gitignore", ""}, // 首字符为 '.' → 无扩展名
		{"file", ""},
		{"a.", "."},
		{"dir/.env", ""},
		{"a/b/c.d/e", ""},         // basename 是 e
		{"/x/y/file.DOC", ".DOC"}, // 大小写保留（过滤时另行 toLowerCase）
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := jsExtname(tt.in); got != tt.want {
				t.Fatalf("jsExtname(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestPathBasenameStripExt(t *testing.T) {
	tests := []struct {
		p, ext string
		want   string
	}{
		{"论文 final.pdf", ".pdf", "论文 final"},
		{"x.tar.gz", ".gz", "x.tar"},
		{".pdf", ".pdf", ".pdf"}, // basename 恰等于 ext 时 Node 不剥离
		{"a", ".pdf", "a"},
		{"/tmp/x.md", ".md", "x"},
	}
	for _, tt := range tests {
		t.Run(tt.p, func(t *testing.T) {
			if got := pathBasenameStripExt(tt.p, tt.ext); got != tt.want {
				t.Fatalf("pathBasenameStripExt(%q, %q) = %q, want %q", tt.p, tt.ext, got, tt.want)
			}
		})
	}
}

// ── 上传文件名清洗（upload.ts:13-39）───────────────────────────────

func TestDecodeOriginalName(t *testing.T) {
	// Go 的 multipart 文件名即原始字节（无 Node busboy 的 latin1 中间态），
	// 修复函数为恒等：合法 UTF-8 / 非法字节 / 含替换符一律原样返回
	tests := []string{
		"report.pdf",
		"学习资料.docx",
		"\xe4\xb8", // 非法 UTF-8 字节
		"broken\xff\xfe.name",
		"",
	}
	for _, tt := range tests {
		if got := decodeOriginalName(tt); got != tt {
			t.Fatalf("decodeOriginalName(%q) = %q, want 原样返回", tt, got)
		}
	}
}

func TestSanitizeUploadBase(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"字母数字保留", "abc123_X-Y", "abc123_X-Y"},
		{"空格与点替换", "a b.c", "a_b_c"},
		{"CJK 保留", "学习论文", "学习论文"},
		{"CJK 以外全角文字替换（片假名不在 U+4E00-9FFF）", "日本語テキスト", "日本語____"},
		{"40 码元截断", strings.Repeat("字", 50), strings.Repeat("字", 40)},
		{"空串兜底 file", "", "file"},
		{"全角标点替换（CJK 保留）", "《论文》", "_论文_"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeUploadBase(tt.in); got != tt.want {
				t.Fatalf("sanitizeUploadBase(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestBuildUploadFilename(t *testing.T) {
	tests := []struct {
		name   string
		in     string
		wantRe string // stamp 随机，用正则校验整体形状
	}{
		{"中文名", "论文 final.pdf", `^[0-9]+_[0-9a-z]{6}__论文_final\.pdf$`},
		{"无扩展名", "README", `^[0-9]+_[0-9a-z]{6}__README$`},
		{"空名兜底", "", `^[0-9]+_[0-9a-z]{6}__file$`},
		{"整名即扩展名（extname 对首字符点返回空）", ".pdf", `^[0-9]+_[0-9a-z]{6}___pdf$`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			re := regexp.MustCompile(tt.wantRe)
			for i := 0; i < 20; i++ { // 多跑几轮覆盖随机段
				got := buildUploadFilename(tt.in)
				if !re.MatchString(got) {
					t.Fatalf("buildUploadFilename(%q) = %q, want match %s", tt.in, got, tt.wantRe)
				}
			}
		})
	}
}

// ── 上传过滤（upload.ts:44-90）────────────────────────────────────

func TestValidateUploadFile(t *testing.T) {
	docReject := "暂不支持 .doc/.ppt 格式，请先转换为 .docx/.pptx 后上传"
	unsupported := "不支持的文件格式，仅支持：markdown, docx, pptx, pdf, txt, csv, xlsx, 图片"
	tests := []struct {
		name    string
		rawName string
		mime    string
		wantErr string // "" 表示放行
	}{
		{".doc 扩展名拒绝", "x.doc", "application/octet-stream", docReject},
		{".ppt 扩展名拒绝", "x.ppt", "", docReject},
		{"msword mime 拒绝", "x.bin", "application/msword", docReject},
		{"ms-powerpoint mime 拒绝", "x", "application/vnd.ms-powerpoint", docReject},
		{".docx 放行", "x.docx", "application/octet-stream", ""},
		{"大写扩展名放行（过滤前 toLowerCase）", "x.PDF", "", ""},
		{"octet-stream mime 放行（任意扩展名，upload.ts:64 允许清单含它）", "x.exe", "application/octet-stream", ""},
		{"markdown mime 放行", "x", "text/markdown", ""},
		{"image/webp 放行", "x.webp", "image/webp", ""},
		{"未知扩展名 + 未列 mime 拒绝", "x.exe", "application/x-msdownload", unsupported},
		{"空名空 mime 拒绝", "x.xyz", "", unsupported},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateUploadFile(tt.rawName, tt.mime)
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tt.wantErr {
				t.Fatalf("validateUploadFile(%q, %q) error = %q, want %q", tt.rawName, tt.mime, got, tt.wantErr)
			}
		})
	}
}

// ── 分页拆分（upload.ts:135 / materials.ts:196-216）───────────────

func TestSplitUploadPages(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"a\fb", []string{"a", "b"}},
		{"a\n\nb", []string{"a", "b"}},
		{"a\f\fb\f\nc", []string{"a", "b", "\nc"}}, // 单个 \n 不拆且保留
		{"", []string{}},                           // "".split(re) → [""] → filter(Boolean) → []
		{"\n", []string{"\n"}},                     // 单换行段是 truthy
		{"a\r\n\r\nb", []string{"a\r\n\r\nb"}},     // CRLF 双换行不拆：正则只认 \n\n+
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got := splitUploadPages(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("splitUploadPages(%q) = %v, want %v", tt.in, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("splitUploadPages(%q)[%d] = %q, want %q", tt.in, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestPaginateFileContent(t *testing.T) {
	tests := []struct {
		name      string
		text      string
		pageCount int
		want      []fileContentPage
	}{
		{"换页符拆页并 trim", "  a  \f  b  ", 0, []fileContentPage{
			{1, "a"}, {2, "b"},
		}},
		{"纯换页符串全空段", "\f\f", 0, []fileContentPage{}},
		{"无换页符单页不 trim", "a\n\nb", 0, []fileContentPage{
			{1, "a\n\nb"},
		}},
		{"按页数均分 ASCII", strings.Repeat("x", 30), 3, []fileContentPage{
			{1, strings.Repeat("x", 10)}, {2, strings.Repeat("x", 10)}, {3, strings.Repeat("x", 10)},
		}},
		{"页数多于内容跳空页", "ab", 5, []fileContentPage{
			{1, "a"}, {2, "b"},
		}},
		{"CJK 按码元均分", "中中中中中", 2, []fileContentPage{
			{1, "中中中"}, {2, "中中"},
		}},
		{"空文本多页全部为空", "", 3, []fileContentPage{}},
		{"单页空文本", "", 0, []fileContentPage{{1, ""}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := paginateFileContent(tt.text, tt.pageCount)
			if len(got) != len(tt.want) {
				t.Fatalf("paginateFileContent 页数 = %d, want %d（%v）", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("paginateFileContent[%d] = %+v, want %+v", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// ── 检索摘要（file-contents.ts:56-67）─────────────────────────────

func TestBuildSearchSnippet(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		keyword string
		want    string
	}{
		{"命中下标 0 走前 200 分支（短文本）", "keyword rest", "keyword", "keyword rest"},
		{"命中下标 0 走前 200 分支（长文本补 ...）", "key" + strings.Repeat("a", 300), "key", "key" + strings.Repeat("a", 197) + "..."},
		{"命中中部两侧省略号", strings.Repeat("a", 150) + "key" + strings.Repeat("b", 150), "key",
			"..." + strings.Repeat("a", 80) + "key" + strings.Repeat("b", 117) + "..."},
		{"命中下标 1 无前导省略号", "akey" + strings.Repeat("b", 300), "key",
			"akey" + strings.Repeat("b", 117) + "..."},
		{"未命中取前 200", strings.Repeat("c", 250), "zzz", strings.Repeat("c", 200) + "..."},
		{"大小写不敏感命中", "AAA bBB ccc", "bbb", "AAA bBB ccc"},
		{"CJK 按码元截取", strings.Repeat("中", 100) + "找" + strings.Repeat("中", 199), "找",
			"..." + strings.Repeat("中", 80) + "找" + strings.Repeat("中", 119) + "..."},
		{"短文本命中尾部无省略号", "hello world", "world", "hello world"},
		{"空文本", "", "k", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildSearchSnippet(tt.text, tt.keyword); got != tt.want {
				t.Fatalf("buildSearchSnippet 长度 = %d, want %d（got %.30q want %.30q）",
					len(got), len(tt.want), got, tt.want)
			}
		})
	}
}

// ── UTF-16 码元语义帮助函数（JS String.length / slice）────────────

func TestJSUTF16Helpers(t *testing.T) {
	// 长度：ASCII/BMP 1 码元，增补平面（emoji）2 码元
	lengths := []struct {
		in   string
		want int
	}{
		{"", 0}, {"abc", 3}, {"中", 1}, {"😀", 2}, {"a😀b", 4},
	}
	for _, tt := range lengths {
		if got := jsUTF16Len(tt.in); got != tt.want {
			t.Fatalf("jsUTF16Len(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}

	slices := []struct {
		in         string
		start, end int
		want       string
	}{
		{"中中中中", 1, 3, "中中"},
		{"abcdef", 0, 200, "abcdef"}, // end 越界收敛
		{"abcdef", 4, 2, ""},         // end <= start
		{"a😀b", 0, 3, "a😀"},          // 😀 占 2 码元：[0,3) = a + 完整代理对
		{"abcdef", -1, 3, "abc"},     // start 负数收敛到 0
	}
	for _, tt := range slices {
		if got := jsUTF16Slice(tt.in, tt.start, tt.end); got != tt.want {
			t.Fatalf("jsUTF16Slice(%q, %d, %d) = %q, want %q", tt.in, tt.start, tt.end, got, tt.want)
		}
	}

	indices := []struct {
		hay, needle string
		want        int
	}{
		{"abcdef", "cd", 2},
		{"xx ABC yy abc", "abc", 3}, // 大小写不敏感（lower 后首个命中）
		{"中中找中", "找", 2},
		{"abc", "zz", -1},
		{"", "a", -1},
	}
	for _, tt := range indices {
		if got := jsUTF16IndexOf(tt.hay, tt.needle); got != tt.want {
			t.Fatalf("jsUTF16IndexOf(%q, %q) = %d, want %d", tt.hay, tt.needle, got, tt.want)
		}
	}
}

// ── 文件定位 / viewUrl / mime（materials.ts:127-225）──────────────

func TestMatchFuzzy(t *testing.T) {
	tests := []struct {
		file, search string
		want         bool
	}{
		{"论文a.txt", "论文", true},
		{"短.txt", "很长的名字含短.txt", true}, // 反向包含
		{"abc", "xyz", false},
		{"", "x", true}, // searchName.includes('') 恒真（空文件名实际不可达）
	}
	for _, tt := range tests {
		if got := matchFuzzy(tt.file, tt.search); got != tt.want {
			t.Fatalf("matchFuzzy(%q, %q) = %v, want %v", tt.file, tt.search, got, tt.want)
		}
	}
}

func TestMimeForExt(t *testing.T) {
	tests := []struct {
		ext  string
		want string
	}{
		{".pdf", "application/pdf"},
		{".csv", "text/plain"}, // materials.ts:174 csv 归 text/plain
		{".md", "text/markdown"},
		{".xlsx", "application/octet-stream"}, // 映射表无 xlsx → 缺省
		{".xyz", "application/octet-stream"},
		{"", "application/octet-stream"},
	}
	for _, tt := range tests {
		if got := mimeForExt(tt.ext); got != tt.want {
			t.Fatalf("mimeForExt(%q) = %q, want %q", tt.ext, got, tt.want)
		}
	}
}

func TestBuildViewURL(t *testing.T) {
	tests := []struct {
		baseURL, filePath string
		want              string
	}{
		{"http://b:9091", `/srv/test_data/学习资料/a b.pdf`, "http://b:9091/test-data/a%20b.pdf"},
		{"http://b:9091", `C:\x\uploads\中.md`, "http://b:9091/uploads/%E4%B8%AD.md"},
		{"http://b:9091", "/etc/passwd", ""},
		{"http://host", "/srv/other/中.md", ""},
	}
	for _, tt := range tests {
		if got := buildViewURL(tt.baseURL, tt.filePath); got != tt.want {
			t.Fatalf("buildViewURL(%q, %q) = %q, want %q", tt.baseURL, tt.filePath, got, tt.want)
		}
	}
}

func TestProcessStatusFor(t *testing.T) {
	if got := processStatusFor(nil); got != "failed" {
		t.Fatalf("processStatusFor(nil) = %q, want failed", got)
	}
	id := 3
	if got := processStatusFor(&id); got != "processing" {
		t.Fatalf("processStatusFor(&3) = %q, want processing", got)
	}
}

// ── 不触达 DB 的请求校验分支（400 路径，均在数据库调用之前）────────

// doMaterialsRequest 构造带 userId 的请求并执行 handler。
// body 为 nil 时用 http.NoBody（避免 typed-nil *bytes.Buffer 进 io.Reader
// 接口后在读取时 panic）。
func doMaterialsRequest(t *testing.T, method, target, userID, contentType string, body *bytes.Buffer, fn http.HandlerFunc) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = body
	}
	req := httptest.NewRequest(method, target, reader)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if userID != "" {
		req = req.WithContext(auth.WithUserID(req.Context(), userID))
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

// TestUploadMultipartValidation 覆盖 multer 等价物的拒绝分支
// （fileFilter 在落盘之前执行，全程不写磁盘、不触库）。
func TestUploadMultipartValidation(t *testing.T) {
	newMultipart := func(t *testing.T, build func(*multipart.Writer)) (string, *bytes.Buffer) {
		t.Helper()
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		build(mw)
		if err := mw.Close(); err != nil {
			t.Fatal(err)
		}
		return mw.FormDataContentType(), &buf
	}

	t.Run("无文件字段", func(t *testing.T) {
		ct, body := newMultipart(t, func(mw *multipart.Writer) {
			_ = mw.WriteField("title", "只有文本字段")
		})
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1", ct, body, handleUpload)
		if status != 400 || resp != `{"error":"请选择要上传的文件"}` {
			t.Fatalf("status=%d body=%s, want 400 请选择要上传的文件", status, resp)
		}
	})

	t.Run(".doc 扩展名拒绝", func(t *testing.T) {
		ct, body := newMultipart(t, func(mw *multipart.Writer) {
			w, _ := mw.CreateFormFile("file", "旧文档.doc")
			_, _ = w.Write([]byte("x"))
		})
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1", ct, body, handleUpload)
		want := `{"error":"暂不支持 .doc/.ppt 格式，请先转换为 .docx/.pptx 后上传"}`
		if status != 400 || resp != want {
			t.Fatalf("status=%d body=%s, want 400 %s", status, resp, want)
		}
	})

	t.Run("msword mime 拒绝", func(t *testing.T) {
		ct, body := newMultipart(t, func(mw *multipart.Writer) {
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", `form-data; name="file"; filename="report.bin"`)
			h.Set("Content-Type", "application/msword")
			w, _ := mw.CreatePart(h)
			_, _ = w.Write([]byte("x"))
		})
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1", ct, body, handleUpload)
		want := `{"error":"暂不支持 .doc/.ppt 格式，请先转换为 .docx/.pptx 后上传"}`
		if status != 400 || resp != want {
			t.Fatalf("status=%d body=%s, want 400 %s", status, resp, want)
		}
	})

	t.Run("未知扩展名 + 未列 mime 拒绝", func(t *testing.T) {
		// 注意不能用 CreateFormFile（其 mime 固定 application/octet-stream，
		// 而 octet-stream 在 TS 允许清单里，任意扩展名都放行——upload.ts:64/85）
		ct, body := newMultipart(t, func(mw *multipart.Writer) {
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", `form-data; name="file"; filename="程序.exe"`)
			h.Set("Content-Type", "application/x-msdownload")
			w, _ := mw.CreatePart(h)
			_, _ = w.Write([]byte("x"))
		})
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1", ct, body, handleUpload)
		want := `{"error":"不支持的文件格式，仅支持：markdown, docx, pptx, pdf, txt, csv, xlsx, 图片"}`
		if status != 400 || resp != want {
			t.Fatalf("status=%d body=%s, want 400 %s", status, resp, want)
		}
	})

	t.Run("非 file 字段名的文件", func(t *testing.T) {
		ct, body := newMultipart(t, func(mw *multipart.Writer) {
			w, _ := mw.CreateFormFile("avatar", "a.txt")
			_, _ = w.Write([]byte("x"))
		})
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1", ct, body, handleUpload)
		want := `{"error":"文件上传错误: Unexpected field"}`
		if status != 400 || resp != want {
			t.Fatalf("status=%d body=%s, want 400 %s", status, resp, want)
		}
	})

	t.Run("非 multipart 请求体", func(t *testing.T) {
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/upload", "user-1",
			"application/json", bytes.NewBufferString(`{}`), handleUpload)
		if status != 400 || !strings.Contains(resp, `"error"`) {
			t.Fatalf("status=%d body=%s, want 400 带 error 字段", status, resp)
		}
	})
}

// TestFileContentsValidation 覆盖两个 400 校验分支（均在 dbClient 之前）。
func TestFileContentsValidation(t *testing.T) {
	t.Run("draftId 非数字", func(t *testing.T) {
		status, resp := doMaterialsRequest(t, http.MethodGet, "/api/v1/file-contents/abc",
			"user-1", "", nil, handleFileContentsGet)
		if status != 400 || resp != `{"error":"无效的 draftId"}` {
			t.Fatalf("status=%d body=%s, want 400 无效的 draftId", status, resp)
		}
	})

	t.Run("search 缺 keyword", func(t *testing.T) {
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/file-contents/search",
			"user-1", "application/json", bytes.NewBufferString(`{}`), handleFileContentsSearch)
		if status != 400 || resp != `{"error":"缺少 keyword 参数"}` {
			t.Fatalf("status=%d body=%s, want 400 缺少 keyword 参数", status, resp)
		}
	})

	t.Run("search 空 body 按 {} 处理（express.json 语义）", func(t *testing.T) {
		status, resp := doMaterialsRequest(t, http.MethodPost, "/api/v1/file-contents/search",
			"user-1", "application/json", bytes.NewBufferString(``), handleFileContentsSearch)
		if status != 400 || resp != `{"error":"缺少 keyword 参数"}` {
			t.Fatalf("status=%d body=%s, want 400 缺少 keyword 参数（空 body → {}）", status, resp)
		}
	})
}
