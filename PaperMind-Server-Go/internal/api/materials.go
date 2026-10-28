package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
)

// ── 资料组（materials.go）───────────────────────────────────────────
// 拥有者：资料组工程师。TS 源：server/src/routes/materials.ts（259 行）+
// upload.ts（246 行）+ file-contents.ts（83 行）。
//
// 响应形状逐路由对照 TS：
//   - GET /materials 列表与 POST / PUT 的返回都是 200 {"data": ...}
//     （materials.ts:53/97 用 res.json 非 201，与 PORTING.md 的 201 惯例
//     不同，以 TS 源码为准）；DELETE 200 {"success": true}
//   - GET /materials/{id}/file-content 404 分支带额外字段 name
//     （materials.ts:162 `json({ error, name })`），其余错误仅 {"error"}
//   - POST /upload 成功响应是扁平对象（无 data 包装，upload.ts:221-232）；
//     兜底响应只含 fileKey/fileUrl/fileName/draftId:null/extracted:false
//   - file-contents GET 非法 draftId 400「无效的 draftId」；search 缺
//     keyword 400「缺少 keyword 参数」
//
// guest 语义：materials 各路由兜底 `(req as any).userId || 'guest'` 复用
// notes.go 的 writeUserID；GET / 列表的过滤条件是 `if (userId)`（真值即可，
// 无 !== 'guest' 排除，materials.ts:17 与 knowledge-nodes.ts:18 不同）。
//
// 查询结果以 PostgREST 返回的原始 JSON 透传（不经过 Go 结构体重组），
// 列名/列序与 TS 侧 supabase-js 完全一致；:id/file-content 与 search
// 需要读字段值，才解到局部结构体。

// maxUploadFileSize 对应 upload.ts:43 multer limits.fileSize（20MB）。
const maxUploadFileSize = 20 * 1024 * 1024

// uploadPageSplitRe 对应 upload.ts:135 的 /\f+|\n\n+/（优先按换页符拆页，
// PPTX 逐幻灯片；否则按空行分段）。
var uploadPageSplitRe = regexp.MustCompile(`\f+|\n\n+`)

// ═══ JS 语义帮助函数（本组专用；通用真值/日期助手见 notes.go）═══

// jsEncodeURIComponent 复刻 JS encodeURIComponent：仅 A-Za-z0-9 - _ . ! ~ * ' ( )
// 不转义，其余按 UTF-8 字节大写十六进制百分号编码（空格编码为 %20 而非 +）。
// 用于 materials.ts:222-224 的 viewUrl 拼接。Go url.QueryEscape 的保留字
// 集与 JS 不同（会转义 ! * ' ( ) 且空格变 +），故单独实现。
func jsEncodeURIComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == '!' || r == '~' || r == '*' ||
			r == '\'' || r == '(' || r == ')' {
			b.WriteRune(r)
			continue
		}
		for _, by := range []byte(string(r)) {
			fmt.Fprintf(&b, "%%%02X", by)
		}
	}
	return b.String()
}

// pathBasename 复刻 Node path.basename（win32 语义：/ 与 \ 都是分隔符），
// 供扩展名/文件名处理使用（upload.ts:30、materials.ts:222）。
func pathBasename(p string) string {
	if p == "" {
		return p
	}
	if idx := strings.LastIndexAny(p, `/\`); idx >= 0 {
		return p[idx+1:]
	}
	return p
}

// jsExtname 复刻 Node path.extname：取 basename 中最后一个 '.' 起的后缀；
// '.' 是 basename 首字符（如 .gitignore）或无 '.' 时返回 ""。
// Go filepath.Ext 对 ".gitignore" 会返回整体（差异点），故单独实现。
func jsExtname(p string) string {
	base := pathBasename(p)
	if base == "" || base == "." || base == ".." {
		return ""
	}
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return ""
	}
	return base[dot:]
}

// pathBasenameStripExt 复刻 path.basename(decoded, ext)：取 basename 并
// 去掉指定后缀（ext 含点）。basename 恰等于 ext 时 Node 不剥离
// （path.basename('foo','foo') → 'foo'），此处对齐。
func pathBasenameStripExt(p, ext string) string {
	base := pathBasename(p)
	if ext != "" && base != ext && strings.HasSuffix(base, ext) {
		return base[:len(base)-len(ext)]
	}
	return base
}

// decodeOriginalName 对应 upload.ts:13-20 的 latin1→utf8 文件名修复。
// Node 里 busboy 把 Content-Disposition 的 filename 按 latin1 解成字符串，
// 需要显式转回 UTF-8；Go 的 part.FileName() 本身就是原始字节串（未转码），
// 字符串语义即「按 UTF-8 解释」，两种分支在 Go 中都恒等返回原值：
//   - 字节为合法 UTF-8 且无 U+FFFD → Node 修复结果与原字节相同；
//   - 字节非法 UTF-8 → Node 因含替换字符回退 latin1 字符串，Go 无该中间
//     表示，同样原样返回（JSON 序列化按原始字节写出，与 Node 会把每个
//     latin1 字符重编码为 UTF-8 存在字节级差异，仅影响本就乱码的名字）。
func decodeOriginalName(name string) string {
	// 合法 UTF-8 且无 U+FFFD → Node 修复结果 == 原字节（原样返回）；
	// 否则 Node 回退 latin1 字符串，Go 原样返回字节串（见上）
	return name
}

// jsUTF16Len 返回字符串的 UTF-16 码元数（JS 的 String.length）。
// TS 的 slice/length 都按 UTF-16 码元计，BMP 内 1 rune = 1 码元，
// 增补平面（emoji 等）1 rune = 2 码元。
func jsUTF16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// jsUTF16Slice 复刻 JS String.prototype.slice(start, end)：按 UTF-16 码元
// 下标截取（upload.ts:139/146/170 与 file-contents.ts:59-64 的截断，
// materials.ts:206-210 的按页均分）。越界自动收敛，end <= start 返回 ""。
func jsUTF16Slice(s string, start, end int) string {
	u := utf16.Encode([]rune(s))
	if start < 0 {
		start = 0
	}
	if end > len(u) {
		end = len(u)
	}
	if start >= len(u) || end <= 0 || end <= start {
		return ""
	}
	return string(utf16.Decode(u[start:end]))
}

// jsUTF16IndexOf 复刻 a.toLowerCase().indexOf(b.toLowerCase())：返回首次
// 匹配的 UTF-16 码元下标，未找到返回 -1。JS toLowerCase 是 Unicode 全映射、
// Go strings.ToLower 是简单映射，二者对 ASCII/CJK 完全一致，仅个别冷门
// 字符（如 U+0130）的映射结果不同，属可接受近似。
func jsUTF16IndexOf(hay, needle string) int {
	byteIdx := strings.Index(strings.ToLower(hay), strings.ToLower(needle))
	if byteIdx < 0 {
		return -1
	}
	return jsUTF16Len(hay[:byteIdx])
}

// ═══ upload：文件过滤与落盘（upload.ts:26-91 的 multer 等价物）═══

// uploadFilterError / 上传过滤的两组判定清单（upload.ts:51-89）。
var (
	uploadRejectExts  = map[string]bool{".doc": true, ".ppt": true}
	uploadRejectMimes = map[string]bool{
		"application/msword":            true,
		"application/vnd.ms-powerpoint": true,
	}
	uploadAllowedExts = map[string]bool{
		".md": true, ".docx": true, ".pptx": true, ".pdf": true, ".txt": true,
		".csv": true, ".xlsx": true, ".jpg": true, ".jpeg": true, ".png": true,
		".gif": true, ".webp": true,
	}
	uploadAllowedMimes = map[string]bool{
		"application/pdf": true,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   true,
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
		"text/markdown":            true,
		"text/plain":               true,
		"application/octet-stream": true,
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
		"image/jpeg": true,
		"image/png":  true,
		"image/gif":  true,
		"image/webp": true,
	}
)

// validateUploadFile 复刻 upload.ts:44-90 的 multer fileFilter（对原始
// originalname 与 mime 的小写判定；.doc/.ppt 旧版二进制入口拒绝，
// 图片放行走「无文本」诚实处理）。返回 nil 表示放行。
func validateUploadFile(rawOriginalName, mimeLower string) error {
	ext := strings.ToLower(jsExtname(rawOriginalName))

	// .doc/.ppt 旧版二进制没有可用的提取实现（extract-text 只支持 OOXML），
	// 放行会产生空文本资料，直接在入口处拒绝（issue #7 Task 4）
	if uploadRejectExts[ext] || uploadRejectMimes[mimeLower] {
		return errors.New("暂不支持 .doc/.ppt 格式，请先转换为 .docx/.pptx 后上传")
	}
	if uploadAllowedExts[ext] || uploadAllowedMimes[mimeLower] {
		return nil
	}
	return errors.New("不支持的文件格式，仅支持：markdown, docx, pptx, pdf, txt, csv, xlsx, 图片")
}

// randomBase36 生成 n 位 base36 随机串（Math.random().toString(36).slice(2,8)
// 的等价物；math/rand Go 1.20+ 自动播种）。
func randomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(b)
}

// sanitizeUploadBase 对应 upload.ts:32-35：
// basename 去 ext 后把 [^\w\-一-鿿]（\w=[A-Za-z0-9_]，一-鿿=U+4E00-9FFF
// CJK）以外的字符替换为 '_'，再按 UTF-16 码元截 40 个，空则 'file'。
func sanitizeUploadBase(base string) string {
	var out []rune
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '-',
			r >= 0x4E00 && r <= 0x9FFF:
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	if len(out) > 40 {
		out = out[:40]
	}
	if len(out) == 0 {
		return "file"
	}
	return string(out)
}

// buildUploadFilename 复刻 upload.ts:28-38 的 multer 磁盘文件名：
// `${Date.now()}_${random36}__${sanitizedBase}${ext}`（ext 含点，取自解码后
// 的 originalname，可能含 CJK）。
func buildUploadFilename(decodedName string) string {
	ext := jsExtname(decodedName)
	base := sanitizeUploadBase(pathBasenameStripExt(decodedName, ext))
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 10) + "_" + randomBase36(6)
	return stamp + "__" + base + ext
}

// savedUpload 是一次成功落盘的上传产物。
type savedUpload struct {
	filename  string            // 磁盘文件名（stamp__base.ext）
	rawName   string            // 原始 originalname（未解码，兜底响应用）
	mimeType  string            // part 的 Content-Type（缺省 application/octet-stream，与 busboy 一致）
	formValue map[string]string // 其余文本字段（multer 收进 req.body，重复字段后者覆盖）
}

// receiveUpload 是 multer(upload.single('file')) 的流式等价物：遍历
// multipart 各 part，文本字段收进 form，名为 file 的文件 part 经 fileFilter
// 校验后落盘到 config.UploadDir。所有失败路径已写好 400 响应
// （upload.ts:96-101：MulterError → 「文件上传错误: <msg>」，fileFilter 与
// 磁盘错误 → 原样 err.message），返回 false 表示响应已写。
func receiveUpload(w http.ResponseWriter, r *http.Request) (*savedUpload, bool) {
	mr, err := r.MultipartReader()
	if err != nil {
		// 非 multipart 请求体：TS 侧 multer/busboy 同样走 400 err.message
		//（错误文案是框架层差异）
		Error(w, http.StatusBadRequest, err.Error())
		return nil, false
	}

	uploadDir := config.Load().UploadDir
	var saved *savedUpload
	form := map[string]string{}

	fail := func(msg string) bool {
		Error(w, http.StatusBadRequest, msg)
		return false
	}

	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fail(err.Error())
		}

		// 文本字段（无 filename）：busboy 全部收进 req.body
		if part.FileName() == "" {
			data, err := io.ReadAll(io.LimitReader(part, 10<<20))
			if err != nil {
				return nil, fail(err.Error())
			}
			form[part.FormName()] = string(data)
			continue
		}

		// upload.single('file')：非 file 的文件字段 → MulterError「Unexpected field」
		if part.FormName() != "file" || saved != nil {
			return nil, fail("文件上传错误: Unexpected field")
		}

		mime := part.Header.Get("Content-Type")
		if mime == "" {
			mime = "application/octet-stream" // busboy 对缺失 Content-Type 的默认值
		}
		if ferr := validateUploadFile(part.FileName(), strings.ToLower(mime)); ferr != nil {
			return nil, fail(ferr.Error()) // fileFilter 抛出的普通 Error：原样 message
		}

		// upload.ts:22-24 启动时建目录；此处兜底再建一次（目录被清后首个上传）
		if err := os.MkdirAll(uploadDir, 0o755); err != nil {
			return nil, fail(err.Error()) // multer 磁盘错误 → 400 err.message
		}
		filename := buildUploadFilename(decodeOriginalName(rawOrString(part.FileName(), "")))
		dst, err := os.Create(filepath.Join(uploadDir, filename))
		if err != nil {
			return nil, fail(err.Error())
		}
		// 20MB 上限：多读 1 字节用于判定超限（multer LIMIT_FILE_SIZE）
		n, err := io.Copy(dst, io.LimitReader(part, maxUploadFileSize+1))
		closeErr := dst.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(filepath.Join(uploadDir, filename)) // multer 出错时会删除半成品
			return nil, fail(err.Error())
		}
		if n > maxUploadFileSize {
			_ = os.Remove(filepath.Join(uploadDir, filename))
			return nil, fail("文件上传错误: File too large")
		}

		saved = &savedUpload{
			filename:  filename,
			rawName:   part.FileName(),
			mimeType:  mime,
			formValue: form,
		}
	}

	if saved == nil {
		return nil, fail("请选择要上传的文件")
	}
	return saved, true
}

// rawOrString 复刻 `file.originalname || ”` / `|| 'file'` 的字符串兜底。
func rawOrString(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

// ═══ upload：入库与后台分类（upload.ts:108-232）═══

// uploadSuccessResponse 是 upload.ts:221-232 的扁平成功响应（无 data 包装）。
type uploadSuccessResponse struct {
	FileKey        string `json:"fileKey"`
	FileURL        string `json:"fileUrl"`
	FileName       string `json:"fileName"`
	MimeType       string `json:"mimeType"`
	DraftID        *int   `json:"draftId"`
	MaterialID     *int   `json:"materialId"`
	Extracted      bool   `json:"extracted"`
	Classification any    `json:"classification"` // 分类已转后台，恒 null（issue #7 Task 3）
	ProcessStatus  string `json:"processStatus"`
}

// uploadFallbackResponse 是 upload.ts:235-241 的兜底响应（外层 catch），
// 字段集比成功响应少（无 mimeType/materialId/classification/processStatus）。
type uploadFallbackResponse struct {
	FileKey   string `json:"fileKey"`
	FileURL   string `json:"fileUrl"`
	FileName  string `json:"fileName"`
	DraftID   *int   `json:"draftId"`
	Extracted bool   `json:"extracted"`
}

// handleUpload 对应 POST /api/v1/upload（upload.ts:94-244）。
func handleUpload(w http.ResponseWriter, r *http.Request) {
	saved, ok := receiveUpload(w, r)
	if !ok {
		return
	}

	userID := writeUserID(auth.UserID(r.Context()))
	originalName := decodeOriginalName(rawOrString(saved.rawName, "file"))
	filePath := filepath.Join(config.Load().UploadDir, saved.filename)

	draftID, materialID, hasText, err := runUploadPipeline(r.Context(), userID, saved, originalName, filePath)
	if err != nil {
		// 外层 catch-all（upload.ts:233-242）：文件已落盘，仍返回 200 扁平兜底
		log.Printf("[upload] Error: %v", err)
		JSON(w, http.StatusOK, uploadFallbackResponse{
			FileKey:   saved.filename,
			FileURL:   "/uploads/" + saved.filename,
			FileName:  originalName,
			DraftID:   nil,
			Extracted: false,
		})
		return
	}

	// ====== 异步触发知识分类（issue #7 Task 3：后台处理，请求立即返回）======
	// 可选表单字段：title（自定义标题）、logical_path（用户选择的文件夹
	// 路径，JSON 字符串数组）由客户端随上传提交，避免重复 POST /materials。
	if materialID != nil {
		id := *materialID
		go classifyInBackground(id, userID)
	}

	JSON(w, http.StatusOK, uploadSuccessResponse{
		FileKey:        saved.filename,
		FileURL:        "/uploads/" + saved.filename,
		FileName:       originalName,
		MimeType:       saved.mimeType,
		DraftID:        draftID,
		MaterialID:     materialID,
		Extracted:      hasText,
		Classification: nil,
		ProcessStatus:  processStatusFor(materialID),
	})
}

// processStatusFor 复刻 `materialId ? 'processing' : 'failed'`。
func processStatusFor(materialID *int) string {
	if materialID != nil {
		return "processing"
	}
	return "failed"
}

// runUploadPipeline 执行提取 + draft/file_contents/materials 三段落库
// （upload.ts:108-219）。每段错误各自消化（对应 TS 的 if (draftError)
// console.error / 内层 catch），只有真正意外的错误才向上抛给外层 catch。
func runUploadPipeline(ctx context.Context, userID string, saved *savedUpload, originalName, filePath string) (draftID, materialID *int, hasText bool, err error) {
	extracted, _ := extracttext.ExtractText(filePath, saved.mimeType, originalName)
	hasText = extracted.Text != ""
	isImage := strings.HasPrefix(strings.ToLower(saved.mimeType), "image/")

	// TS 的 client 是模块级单例；Go 惰性取，缺凭据时按「各段落库失败」
	// 处理（等价 TS 里 Supabase 不可达：draftError/matErr 被逐段消化）
	client, clientErr := db.Get()

	// ── 1. draft_pool 落库（upload.ts:115-131）──
	if clientErr != nil {
		log.Printf("[upload] Failed to create draft: %v", clientErr)
	} else {
		content := extracted.Text
		if content == "" {
			if isImage {
				// 图片附件（学习纪要用）无文本可提取，标记为已处理，不进待处理池
				content = "[图片附件] " + originalName
			} else {
				content = "[内容提取失败或格式不支持]"
			}
		}
		status := "unprocessed"
		if hasText || isImage {
			status = "processed"
		}
		rows, derr := client.From(db.TableDraftPool).Single().Insert(ctx, map[string]any{
			"content":   content,
			"file_url":  "/uploads/" + saved.filename,
			"file_name": originalName,
			"status":    status,
			"user_id":   userID,
		})
		if derr != nil {
			log.Printf("[upload] Failed to create draft: %v", derr)
		} else {
			var row struct {
				ID int `json:"id"`
			}
			if jerr := json.Unmarshal(rows, &row); jerr != nil {
				return nil, nil, hasText, jerr
			}
			draftID = &row.ID
		}
	}

	// ── 2. file_contents 分页落库（upload.ts:132-151，错误静默：TS 不解构结果）──
	if clientErr == nil && draftID != nil && hasText {
		if extracted.PageCount > 1 {
			// 优先按换页符 \f 拆页（PPTX 逐幻灯片），否则按空行分段
			pages := splitUploadPages(extracted.Text)
			n := len(pages)
			if extracted.PageCount < n {
				n = extracted.PageCount
			}
			for i := 0; i < n; i++ {
				_, _ = client.From(db.TableFileContents).Insert(ctx, map[string]any{
					"draft_id":       *draftID,
					"extracted_text": jsUTF16Slice(pages[i], 0, 10000),
					"page_number":    i + 1,
				})
			}
		} else {
			_, _ = client.From(db.TableFileContents).Insert(ctx, map[string]any{
				"draft_id":       *draftID,
				"extracted_text": jsUTF16Slice(extracted.Text, 0, 50000),
				// 单页文件统一写第 1 页，保证引用卡片有页码 badge（issue #5）
				"page_number": 1,
			})
		}
	}

	// ── 3. materials 落库（upload.ts:153-179：提取文本随上传入库）──
	if clientErr == nil {
		name := originalName
		if title := saved.formValue["title"]; title != "" {
			name = title // `title || originalName`
		}
		materialInsert := map[string]any{
			"user_id":              userID,
			"name":                 name,
			"file_path":            "/uploads/" + saved.filename,
			"file_type":            saved.mimeType,
			"tags":                 []any{},
			"ai_processed":         false,
			"process_status":       "processing",
			"viewed_after_process": false,
			"extracted_text":       jsUTF16Slice(extracted.Text, 0, 200000),
		}
		if logicalPath := saved.formValue["logical_path"]; logicalPath != "" {
			materialInsert["logical_path"] = logicalPath
		}
		rows, merr := client.From(db.TableMaterials).Single().Insert(ctx, materialInsert)
		if merr != nil {
			// 内层 catch（upload.ts:217-219）：只记日志，materialId 保持 null
			log.Printf("[upload] material insert error: %v", dbErrorMessage(merr))
		} else {
			var row struct {
				ID int `json:"id"`
			}
			if jerr := json.Unmarshal(rows, &row); jerr != nil {
				return draftID, nil, hasText, jerr
			}
			materialID = &row.ID
		}
	}

	return draftID, materialID, hasText, nil
}

// splitUploadPages 对应 upload.ts:135 的 text.split(/\f+|\n\n+/).filter(Boolean)。
func splitUploadPages(text string) []string {
	segments := uploadPageSplitRe.Split(text, -1)
	pages := make([]string, 0, len(segments))
	for _, seg := range segments {
		if seg != "" { // filter(Boolean)：空串剔除，其余（含单个 \n）保留
			pages = append(pages, seg)
		}
	}
	return pages
}

// classifyInBackground 对应 upload.ts:187-216 的 setImmediate 后台分类：
// 直调知识构建组导出的 ProcessContent（fake req/res 的 Go 等价物，勿 HTTP
// 自调，见 PORTING.md:195）；成功路径由其内部写 process_status='processed'，
// 这里只兜底 4xx+ 标记 failed。不能用请求 ctx（响应返回后已取消），
// 对齐 TS 的 detached 执行。
func classifyInBackground(materialID int, userID string) {
	// 后台协程 panic 不得带崩整个进程（对拍实测：知识构建管线的
	// slice 越界曾击穿此处）。记录后按 failed 收尾，对齐 TS 侧
	// 「上传响应不受后台分类异常影响」的服务存活语义。
	defer func() {
		if p := recover(); p != nil {
			log.Printf("[upload] background classification panic (material %d): %v\n%s",
				materialID, p, debug.Stack())
			if client, cerr := db.Get(); cerr == nil {
				_, _ = client.From(db.TableMaterials).Eq("id", strconv.Itoa(materialID)).
					Update(context.Background(), map[string]any{"process_status": "failed"})
			}
		}
	}()
	ctx := context.Background()
	// TS fakeReq.body = { type: 'material', id }（无 file_content → 空串）
	result := ProcessContent(ctx, ProcessContentRequest{
		Type:   "material",
		ID:     materialID,
		UserID: userID,
	}, "")
	if result.Status < 400 {
		return
	}
	// upload.ts:208-209：throw new Error('分类 handler 返回 ' + status) → catch 记日志
	log.Printf("[upload] background classification error: 分类 handler 返回 %d", result.Status)
	client, cerr := db.Get()
	if cerr != nil {
		return
	}
	_, _ = client.From(db.TableMaterials).Eq("id", strconv.Itoa(materialID)).
		Update(ctx, map[string]any{"process_status": "failed"})
}

// ═══ /materials（materials.ts）═══

// handleMaterialsList 获取所有资料。对应 materials.ts:13-26。
// 过滤条件是 `if (userId)` 真值判定（无 !== 'guest' 排除，与
// knowledge-nodes.ts:18 不同）：auth 中间件恒注入非空 ID（guest 为
// GUEST_UUID），实际总是按用户过滤。
func handleMaterialsList(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableMaterials).Select("*").Order("created_at", false)
	if uid := auth.UserID(r.Context()); uid != "" {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleMaterialsCreate 创建资料记录。对应 materials.ts:29-56。
// 注意返回 200（res.json 非 201）；materials 表用 file_path/file_type 列名，
// 请求体里的 file_url/mime_type 需换名后写入。
func handleMaterialsCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r) // express.json 空 body → {}，其余语义同共享助手
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	cleanTags, err := cleanNoteTags(body["tags"]) // (tags||[]).map(...).filter(Boolean)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	insertData := map[string]any{
		"user_id":              userId,
		"name":                 jsOr(jsOr(body["name"], body["title"]), "未命名资料"),
		"tags":                 cleanTags,
		"ai_processed":         false,
		"viewed_after_process": false,
	}
	// logical_path !== undefined 时写入，空值落 null
	if v, exists := body["logical_path"]; exists {
		insertData["logical_path"] = jsOr(v, nil)
	}
	if v := body["file_url"]; jsTruthy(v) {
		insertData["file_path"] = v
	}
	if v := body["mime_type"]; jsTruthy(v) {
		insertData["file_type"] = v
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableMaterials).Single().Insert(r.Context(), insertData)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleMaterialsUpdate 更新资料。对应 materials.ts:59-100。
// title 与 name 都映射到 name 列（请求体两个都给时后者覆盖，
// 等价 TS 的顺序赋值）；updated_at 由服务端时间戳写入。
func handleMaterialsUpdate(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))

	cleanTags, err := cleanNoteTags(body["tags"])
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	updateData := map[string]any{"updated_at": jsNowISO()}
	if v, exists := body["title"]; exists {
		updateData["name"] = v
	}
	if v, exists := body["name"]; exists {
		updateData["name"] = v
	}
	if _, exists := body["tags"]; exists {
		updateData["tags"] = cleanTags
	}
	// 其余字段 undefined 不写入（TS 的 !== undefined 判定）
	for _, key := range []string{"processed", "papercore", "logical_path", "ai_processed", "viewed_after_process"} {
		if v, exists := body[key]; exists {
			updateData[key] = v
		}
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableMaterials).
		Eq("id", r.PathValue("id")).Eq("user_id", userId).
		Single().Update(r.Context(), updateData)
	if err != nil {
		// .select().single() 0 行 → PGRST116 → TS throw → 500（与 TS 一致）
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, rows)
}

// handleMaterialsDelete 删除资料。对应 materials.ts:243-257。
func handleMaterialsDelete(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	userId := writeUserID(auth.UserID(r.Context()))
	_, err := client.From(db.TableMaterials).
		Eq("id", r.PathValue("id")).Eq("user_id", userId).
		Delete(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	SuccessTrue(w)
}

// ═══ /materials/{id}/file-content（materials.ts:103-240）═══

// fileContentPage / fileContentData 对应 materials.ts:227-235 的响应形状。
type fileContentPage struct {
	PageNumber int    `json:"page_number"`
	Text       string `json:"text"`
}

type fileContentData struct {
	Pages      []fileContentPage `json:"pages"`
	TotalPages int               `json:"totalPages"`
	FileName   string            `json:"fileName"`
	FileType   string            `json:"fileType"`
	ViewURL    string            `json:"viewUrl"`
}

// fileNotFoundResponse 对应 materials.ts:162 的 404 响应（多一个 name 字段）。
type fileNotFoundResponse struct {
	Error string `json:"error"`
	Name  any    `json:"name"` // material.name 可能为 null
}

// extMimeMap 对应 materials.ts:168-175 的扩展名 → mime 映射。
var extMimeMap = map[string]string{
	".pdf":  "application/pdf",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".md":   "text/markdown",
	".txt":  "text/plain",
	".csv":  "text/plain",
}

// mimeForExt 取 mime，缺省 application/octet-stream（materials.ts:176）。
func mimeForExt(ext string) string {
	if m, ok := extMimeMap[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

// fileExists 等价 fs.existsSync（目录也算存在）。
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// matchFuzzy 对应 materials.ts:154 的
// files.find((f) => f.includes(searchName) || searchName.includes(f))。
func matchFuzzy(file, searchName string) bool {
	return strings.Contains(file, searchName) || strings.Contains(searchName, file)
}

// locateMaterialFile 对应 materials.ts:127-159 的三级文件定位：
// file_path/file_url 去 /uploads/ 前缀 → uploads 目录；name → test_data
// 精确匹配；再模糊匹配（readdir 顺序，NTFS/Go ReadDir 均按文件名排序）。
func locateMaterialFile(material *db.Material, uploadsDir, testDataDir string) string {
	stored := ""
	if material.FilePath != nil && *material.FilePath != "" {
		stored = *material.FilePath
	} else if material.FileURL != nil {
		stored = *material.FileURL
	}
	if stored != "" {
		candidate := filepath.Join(uploadsDir, strings.TrimPrefix(stored, "/uploads/"))
		if fileExists(candidate) {
			return candidate
		}
	}
	if material.Name != nil && *material.Name != "" {
		candidate := filepath.Join(testDataDir, *material.Name)
		if fileExists(candidate) {
			return candidate
		}
	}
	if material.Name != nil && *material.Name != "" {
		// 目录不存在等读取失败静默吞掉（TS try/catch 空）
		if entries, err := os.ReadDir(testDataDir); err == nil {
			for _, e := range entries {
				if matchFuzzy(e.Name(), *material.Name) {
					return filepath.Join(testDataDir, e.Name())
				}
			}
		}
	}
	return ""
}

// buildViewURL 对应 materials.ts:218-225：路径含 test_data → /test-data/，
// 含 uploads → /uploads/，否则空串；basename 过 encodeURIComponent。
func buildViewURL(baseURL, filePath string) string {
	if strings.Contains(filePath, "test_data") {
		return baseURL + "/test-data/" + jsEncodeURIComponent(pathBasename(filePath))
	}
	if strings.Contains(filePath, "uploads") {
		return baseURL + "/uploads/" + jsEncodeURIComponent(pathBasename(filePath))
	}
	return ""
}

// paginateFileContent 对应 materials.ts:196-216 的分页规则：
// 含 \f 按换页符拆（过滤空白段、每页 trim）；否则 pageCount>1 时按 UTF-16
// 长度均分（TS 的 length/slice 均按码元计）；再否则单页原样（不 trim）。
func paginateFileContent(fullText string, pageCount int) []fileContentPage {
	var pages []fileContentPage
	if strings.Contains(fullText, "\f") {
		for _, seg := range strings.Split(fullText, "\f") {
			if strings.TrimSpace(seg) == "" {
				continue // filter((t) => t.trim().length > 0)
			}
			pages = append(pages, fileContentPage{
				PageNumber: len(pages) + 1,
				Text:       strings.TrimSpace(seg),
			})
		}
	} else if pageCount > 1 {
		totalLen := jsUTF16Len(fullText)
		perPage := (totalLen + pageCount - 1) / pageCount // Math.ceil(totalLen / pageCount)
		for i := 0; i < pageCount; i++ {
			start := i * perPage
			end := start + perPage
			if end > totalLen {
				end = totalLen
			}
			chunk := strings.TrimSpace(jsUTF16Slice(fullText, start, end))
			if chunk != "" { // if (chunk)
				pages = append(pages, fileContentPage{PageNumber: i + 1, Text: chunk})
			}
		}
	} else {
		pages = []fileContentPage{{PageNumber: 1, Text: fullText}}
	}
	return pages
}

// writeBackExtractedText 对应 materials.ts:186-193 的 fire-and-forget 回写：
// 老数据首次打开补一次提取，之后直接读库；失败仅告警。
func writeBackExtractedText(id, text string) {
	client, err := db.Get()
	if err != nil {
		return
	}
	if _, uerr := client.From(db.TableMaterials).Eq("id", id).
		Update(context.Background(), map[string]any{
			"extracted_text": jsUTF16Slice(text, 0, 200000),
		}); uerr != nil {
		log.Printf("[file-content] 回写提取文本失败: %v", uerr)
	}
}

// handleMaterialFileContent 获取资料的文件内容（分页提取）。
// 对应 materials.ts:103-240。
func handleMaterialFileContent(w http.ResponseWriter, r *http.Request) {
	userId := writeUserID(auth.UserID(r.Context()))
	id := r.PathValue("id")

	client, ok := dbClient(w)
	if !ok {
		return
	}

	// 1. 获取 material 记录（网络瞬时失败重试，避免误报 Material not found，
	//    materials.ts:109-120：带 Postgres code 的查询错误不重试，直接 404）
	raw, fetchErr := db.RunWithRetry(r.Context(), func() (json.RawMessage, error) {
		rows, qerr := client.From(db.TableMaterials).Select("*").
			Eq("id", id).Eq("user_id", userId).Single().Rows(r.Context())
		if qerr != nil {
			var pe *db.PostgrestError
			if errors.As(qerr, &pe) {
				return nil, nil // 真查询错误（PGRST116 等）→ 按 fetchError 处理 → 404
			}
			return nil, qerr // 网络类错误抛给重试层
		}
		return rows, nil
	}, 4, 400)
	if fetchErr != nil {
		// 重试耗尽：runWithRetry throw lastErr（supabase-client.ts:162）→
		// 路由 catch 500（materials.ts:236-239）——服务端故障不能误报 404
		Error(w, http.StatusInternalServerError, fetchErr.Error())
		return
	}

	var material *db.Material
	if len(raw) > 0 && !isJSONNull(raw) {
		material = &db.Material{}
		if uerr := json.Unmarshal(raw, material); uerr != nil {
			Error(w, http.StatusInternalServerError, uerr.Error())
			return
		}
	}
	if material == nil {
		Error(w, http.StatusNotFound, "Material not found")
		return
	}

	// 2. 定位文件（uploads → test_data 精确 → 模糊）
	uploadsDir := config.Load().UploadDir
	cwd, _ := os.Getwd()
	testDataDir := filepath.Join(cwd, "..", "test_data", "学习资料")
	filePath := locateMaterialFile(material, uploadsDir, testDataDir)
	if filePath == "" {
		var nameVal any
		if material.Name != nil {
			nameVal = *material.Name
		}
		JSON(w, http.StatusNotFound, fileNotFoundResponse{Error: "File not found on disk", Name: nameVal})
		return
	}

	// 3. 提取文本：优先用上传/分类时已落库的 extracted_text（pipeline 约定），
	//    缺失时再从磁盘提取（结果异步回写，之后直接读库）
	ext := strings.ToLower(jsExtname(filePath))
	mimeType := mimeForExt(ext)

	var text string
	var pageCount int
	useStored := material.ExtractedText != nil &&
		utf8.RuneCountInString(strings.TrimSpace(*material.ExtractedText)) >= 5
	if useStored {
		text = *material.ExtractedText
	} else {
		extracted, _ := extracttext.ExtractText(filePath, mimeType, pathBasename(filePath))
		text = extracted.Text
		pageCount = extracted.PageCount
		if text != "" && utf8.RuneCountInString(strings.TrimSpace(text)) >= 5 {
			go writeBackExtractedText(id, text)
		}
	}

	// 4. 分页：按换页符 \f 拆分，否则按页数均分，再否则单页
	pages := paginateFileContent(text, pageCount)

	// 5. 构建可直接访问的文件 URL（BACKEND_BASE_URL 缺省 http://localhost:<PORT>）
	viewURL := buildViewURL(config.Load().BackendBaseURL, filePath)

	fileName := "未知文件"
	if material.Name != nil && *material.Name != "" {
		fileName = *material.Name
	}
	OK(w, fileContentData{
		Pages:      pages,
		TotalPages: len(pages),
		FileName:   fileName,
		FileType:   strings.ToUpper(strings.TrimPrefix(ext, ".")), // '.pdf' → 'PDF'
		ViewURL:    viewURL,
	})
}

// ═══ /file-contents（file-contents.ts）═══

// handleFileContentsGet 获取草稿的分页提取内容。对应 file-contents.ts:9-27。
func handleFileContentsGet(w http.ResponseWriter, r *http.Request) {
	draftID := parseJSInt(r.PathValue("draftId"))
	if draftID == nil {
		Error(w, http.StatusBadRequest, "无效的 draftId")
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	rows, err := client.From(db.TableFileContents).Select("*").
		Eq("draft_id", strconv.Itoa(draftID.(int))).
		Order("page_number", true).
		Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if isJSONNull(rows) {
		OK(w, []any{}) // data || []
		return
	}
	OK(w, rows)
}

// fcSearchResult 对应 file-contents.ts:68-74 的单条检索结果。
type fcSearchResult struct {
	DraftID    json.RawMessage `json:"draft_id"`
	PageNumber json.RawMessage `json:"page_number"`
	Snippet    string          `json:"snippet"`
	FileURL    *string         `json:"file_url"`
	FileName   *string         `json:"file_name"`
}

// buildSearchSnippet 对应 file-contents.ts:56-67 的摘要片段截取：
// 命中下标 >0 时取 [idx-80, idx+120)（越界收敛，两侧补 ...）；
// 否则取前 200 码元（超长补 ...）。全部按 UTF-16 码元计（JS 语义）。
func buildSearchSnippet(text, keyword string) string {
	total := jsUTF16Len(text)
	idx := jsUTF16IndexOf(text, keyword)
	if idx > 0 {
		start := idx - 80
		if start < 0 {
			start = 0
		}
		end := idx + 120
		if end > total {
			end = total
		}
		snippet := jsUTF16Slice(text, start, end)
		if start > 0 {
			snippet = "..." + snippet
		}
		if end < total {
			snippet += "..."
		}
		return snippet
	}
	snippet := jsUTF16Slice(text, 0, 200)
	if total > 200 {
		snippet += "..."
	}
	return snippet
}

// handleFileContentsSearch 全文检索。对应 file-contents.ts:30-81。
func handleFileContentsSearch(w http.ResponseWriter, r *http.Request) {
	body, ok := recordsDecodeBody(w, r)
	if !ok {
		return
	}
	keyword := body["keyword"]
	if !jsTruthy(keyword) {
		Error(w, http.StatusBadRequest, "缺少 keyword 参数")
		return
	}

	client, ok := dbClient(w)
	if !ok {
		return
	}
	query := client.From(db.TableFileContents).
		Select("*, draft_pool(file_url, file_name)").
		Ilike("extracted_text", "%"+pslStringify(keyword)+"%"). // `${keyword}` 模板插值
		Limit(10)
	if draftIDs, isArr := body["draft_ids"].([]any); isArr && len(draftIDs) > 0 {
		vals := make([]string, 0, len(draftIDs))
		for _, v := range draftIDs {
			vals = append(vals, pslStringify(v)) // 数字 1 → "1"（in.(1,2)）
		}
		query = query.In("draft_id", vals)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	var items []struct {
		ExtractedText *string         `json:"extracted_text"`
		DraftID       json.RawMessage `json:"draft_id"`
		PageNumber    json.RawMessage `json:"page_number"`
		DraftPool     *struct {
			FileURL  *string `json:"file_url"`
			FileName *string `json:"file_name"`
		} `json:"draft_pool"`
	}
	if !isJSONNull(rows) {
		if err := json.Unmarshal(rows, &items); err != nil {
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// keyword 非 String 时 TS 在 keyword.toLowerCase() 抛 TypeError → 500
	//（查询已发出，此处对齐其失败时机与文案）
	keywordStr, isStr := keyword.(string)
	if !isStr {
		Error(w, http.StatusInternalServerError, "keyword.toLowerCase is not a function")
		return
	}

	results := make([]fcSearchResult, 0, len(items))
	for _, item := range items {
		text := ""
		if item.ExtractedText != nil {
			text = *item.ExtractedText
		}
		var fileURL, fileName *string
		if item.DraftPool != nil { // item.draft_pool?.file_url
			fileURL = item.DraftPool.FileURL
			fileName = item.DraftPool.FileName
		}
		results = append(results, fcSearchResult{
			DraftID:    item.DraftID,
			PageNumber: item.PageNumber,
			Snippet:    buildSearchSnippet(text, keywordStr),
			FileURL:    fileURL,
			FileName:   fileName,
		})
	}
	OK(w, results)
}

// ═══ 路由注册 ═══

func registerMaterialsRoutes(mux *http.ServeMux) {
	// upload.ts:22-24 — 启动时确保上传目录存在（对应模块加载时的 mkdirSync）
	if err := os.MkdirAll(config.Load().UploadDir, 0o755); err != nil {
		log.Printf("[upload] 创建上传目录 %s 失败: %v", config.Load().UploadDir, err)
	}

	// ── /materials（materials.ts）───────────────────────────────────
	mux.HandleFunc("GET /api/v1/materials", handleMaterialsList)
	mux.HandleFunc("POST /api/v1/materials", handleMaterialsCreate)
	mux.HandleFunc("PUT /api/v1/materials/{id}", handleMaterialsUpdate)
	mux.HandleFunc("DELETE /api/v1/materials/{id}", handleMaterialsDelete) // 200 {"success":true}
	mux.HandleFunc("GET /api/v1/materials/{id}/file-content", handleMaterialFileContent)

	// ── /upload（upload.ts）─────────────────────────────────────────
	mux.HandleFunc("POST /api/v1/upload", handleUpload)

	// ── /file-contents（file-contents.ts）───────────────────────────
	mux.HandleFunc("GET /api/v1/file-contents/{draftId}", handleFileContentsGet)
	mux.HandleFunc("POST /api/v1/file-contents/search", handleFileContentsSearch)
}
