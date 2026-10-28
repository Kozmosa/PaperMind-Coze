package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	pdf "github.com/ledongthuc/pdf"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/retrieval"
)

// ── POST /reprocess-material（knowledge-builder.ts:1232-1423）────────
// 从磁盘重读文件重新分类。与 process-content 的 readMaterialFileFromDisk
//（走 extract-text 全管线）不同，这里是一套**内联**提取逻辑（pdf-parse /
// adm-zip+xml2js / 直读文本），TS 侧两套提取本就有差异，逐分支对齐。

// kbPPTXSlideRe 匹配 ppt/slides/slideN.xml（大小写不敏感，:1307）。
var kbPPTXSlideRe = regexp.MustCompile(`(?i)ppt/slides/slide\d+\.xml`)

// kbPPTXTextRunRe 抓 <a:t> 文本运行节点。TS 用 xml2js 解析整棵树后收集
// a:t 值；正则近似不反转义 XML 实体（&amp; 等），对中文课件无影响。
var kbPPTXTextRunRe = regexp.MustCompile(`<a:t>([^<]*)</a:t>`)

// kbReprocessExtract 复刻 reprocess-material 的第 3 步提取（:1289-1337）。
// 文件读取本身失败（TS 的 fs.readFileSync）上抛 → 路由 catch-all 500；
// .pdf → pdf-parse getText（Go 用 ledongthuc/pdf 整篇拼接近似，解析失败
// 静默空串）；.pptx → 按 entryName 排序抓全部 a:t、join(' ') 压空白；
// .md/.txt → 去 BOM 后 trim；其余扩展名返回空串。
func kbReprocessExtract(filePath string) (string, error) {
	data, err := os.ReadFile(filePath) // fs.readFileSync：读盘失败 → 500
	if err != nil {
		return "", err
	}
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".pdf":
		return kbReprocessPDFFromBytes(data), nil
	case ".pptx":
		return kbReprocessPPTXFromBytes(data), nil
	case ".md", ".txt":
		return kbJSTrim(strings.TrimPrefix(string(data), "\uFEFF")), nil // replace(/^\uFEFF/, '') + trim
	default:
		return "", nil
	}
}

// kbReprocessPDFFromBytes 对应 `new PDFParse({ data: buffer }).getText()`
// （:1294-1299，内层 catch {} 吞错）：整篇按页拼接（extracttext/pdf.go
// 第二级的同款近似），任何失败返回空串。
func kbReprocessPDFFromBytes(data []byte) (text string) {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[reprocess-material] pdf extract panic: %v", e)
			text = ""
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	parts := make([]string, 0, r.NumPage())
	for i := 1; i <= r.NumPage(); i++ {
		t, err := r.Page(i).GetPlainText(nil)
		if err != nil {
			continue // 单页失败跳过（pdf-parse 整篇失败为全空，Go 稍宽容保住其余页）
		}
		parts = append(parts, t)
	}
	return kbJSTrim(strings.Join(parts, "\n")) // (result.text || '').trim()
}

// kbReprocessPPTXFromBytes 对应 adm-zip + xml2js 的 a:t 收集（:1300-1331）：
// slide 文件按名排序（JS localeCompare ≈ 字节序），全部 a:t join(' ') 后
// 压空白并 trim；失败静默返回空串。
func kbReprocessPPTXFromBytes(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	var slideNames []string
	contents := map[string]string{}
	for _, e := range zr.File {
		if !kbPPTXSlideRe.MatchString(e.Name) {
			continue
		}
		rc, err := e.Open()
		if err != nil {
			continue
		}
		body, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			continue
		}
		slideNames = append(slideNames, e.Name)
		contents[e.Name] = string(body)
	}
	sort.Strings(slideNames)
	var allTexts []string
	for _, name := range slideNames {
		for _, m := range kbPPTXTextRunRe.FindAllStringSubmatch(contents[name], -1) {
			allTexts = append(allTexts, m[1])
		}
	}
	return kbJSTrim(kbCollapseJSSpace(strings.Join(allTexts, " ")))
}

// kbIsPostgrestError 判定是否 PostgREST 业务错误（.single() 0 行的
// PGRST116 → 404，与网络错误 → 500 的分流依据）。
func kbIsPostgrestError(err error) bool {
	var pErr *db.PostgrestError
	return err != nil && errors.As(err, &pErr)
}

// handleKnowledgeBuilderReprocessMaterial 重新处理某份资料（从磁盘）。
// 对应 knowledge-builder.ts:1232-1423。
func handleKnowledgeBuilderReprocessMaterial(w http.ResponseWriter, r *http.Request) {
	userID := writeUserID(auth.UserID(r.Context()))
	body, ok := decodeJSONObjectBody(w, r)
	if !ok {
		return
	}
	id := body["id"]
	if !jsTruthy(id) {
		Error(w, http.StatusBadRequest, "id is required")
		return
	}
	idStr := recIDString(id)
	client, ok := dbClient(w)
	if !ok {
		return
	}

	status, resp := func() (int, any) {
		// 1. Get material
		rows, err := client.From(db.TableMaterials).Select("*").
			Eq("id", idStr).Eq("user_id", userID).Single().Rows(r.Context())
		if err != nil {
			if kbIsPostgrestError(err) {
				return http.StatusNotFound, map[string]any{"error": "Material not found"}
			}
			return http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		if isJSONNull(rows) {
			return http.StatusNotFound, map[string]any{"error": "Material not found"}
		}
		var material map[string]any
		if err := json.Unmarshal(rows, &material); err != nil {
			return http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}

		// 2. Find file on disk（uploads → test_data → 模糊匹配）
		storedPath, _ := material["file_path"].(string)
		if storedPath == "" {
			storedPath, _ = material["file_url"].(string)
		}
		name, _ := material["name"].(string)
		filePath := kbFindMaterialFile(storedPath, name, true)
		if filePath == "" {
			// TS：{ error, name } 双键（name 可为 null）
			return http.StatusNotFound, map[string]any{"error": "File not found on disk", "name": material["name"]}
		}

		// 3. Extract text from file
		fileContent, err := kbReprocessExtract(filePath)
		if err != nil {
			return http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		log.Printf("[reprocess-material] %s: extracted %d chars", name, kbUTF16Len(fileContent))

		// Strip TOC (table of contents) to get real content
		fileContent = kbStripTOC(fileContent)
		log.Printf("[reprocess-material] %s: after TOC strip %d chars", name, kbUTF16Len(fileContent))

		// 4. Check readability
		if fileContent == "" || kbUTF16Len(fileContent) < 5 {
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id": id, "status": "skipped", "reason": "no content extracted",
			}}
		}

		if !extracttext.IsReadableText(fileContent) {
			degradedPapercore := kbBuildDegradedPapercore(name, "")
			// 与 process-content 的 forced-degraded 路径一致：保留用户设置的 logical_path
			userPath := kbUserSetLogicalPath(material)
			logicalPath := kbJSONStringify([]string{"/未分类/"})
			if userPath != "" {
				logicalPath = userPath
			}
			if _, uErr := client.From(db.TableMaterials).Eq("id", idStr).Eq("user_id", userID).
				Update(r.Context(), map[string]any{
					"ai_processed":   true,
					"papercore":      degradedPapercore,
					"logical_path":   logicalPath,
					"process_status": "processed",
				}); kbSwallowPostgrest(uErr) != nil {
				return http.StatusInternalServerError, map[string]any{"error": uErr.Error()}
			}
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id": id, "status": "processed", "papercore": degradedPapercore, "reason": "degraded",
			}}
		}

		// 5. Generate papercore first, then tags from papercore
		existingHierarchy, err := kbGetExistingTagHierarchy(r.Context(), client, userID)
		if err != nil {
			return http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		papercore := kbGeneratePapercore(r.Context(), fileContent, name, "")
		result, gErr := kbGenerateHierarchicalTags(r.Context(), client, papercore,
			kbUTF16Len(fileContent), existingHierarchy, userID)
		if gErr != nil {
			return http.StatusInternalServerError, map[string]any{"error": gErr.Error()}
		}

		logicalPaths := kbBuildLogicalPaths(result.L1, result.L2, result.Tags)
		hierarchicalTags := kbFilterEmpty(append([]string{result.L1, result.L2}, result.Tags...))

		// 6. Update
		if err := kbUpdateAIProcessResult(r.Context(), client, db.TableMaterials, map[string]any{
			"tags":                 hierarchicalTags,
			"papercore":            papercore,
			"logical_path":         kbJSONStringify(logicalPaths),
			"ai_processed":         true,
			"process_status":       "processed",
			"viewed_after_process": false,
			"updated_at":           jsNowISO(),
		}, idStr, userID); err != nil {
			return http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}

		retrieval.ScheduleIndexRebuild(indexRebuildDelay)
		return http.StatusOK, map[string]any{"data": map[string]any{
			"id":           id,
			"tags":         hierarchicalTags,
			"papercore":    papercore,
			"logical_path": logicalPaths,
			"status":       "reprocessed",
		}}
	}()

	JSON(w, status, resp)
	// TS catch 里的 req.params?.id 对该路由恒为 undefined（路由无 :id 参数），
	// process_status='failed' 的兜底标记因此永不执行——保留为无操作以对齐。
}

// mapStr 取行字符串列（薄封装，语义同 kbStrCol）。
func mapStr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// ── POST /process-study-notes（批处理，向后兼容；:1428-1516）────────

// handleKnowledgeBuilderProcessStudyNotes 批处理学习纪要（最多 10 条）。
// 空结果响应是 {data: [], message} 双键。
func handleKnowledgeBuilderProcessStudyNotes(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context()) // TS 不兜底 'guest'
	client, ok := dbClient(w)
	if !ok {
		return
	}

	query := client.From(db.TableStudyNotes).Select("*").
		Eq("ai_processed", "false").Order("created_at", false).Limit(10)
	// 多用户安全：仅处理本人记录（guest 保持旧行为）
	if uid, scoped := scopedUserID(userId); scoped {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		log.Printf("Process study notes error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var unprocessed []map[string]any
	if err := json.Unmarshal(rows, &unprocessed); err != nil {
		unprocessed = nil
	}
	if len(unprocessed) == 0 {
		JSON(w, http.StatusOK, map[string]any{"data": []any{}, "message": "No unprocessed study notes"})
		return
	}

	results := make([]map[string]any, 0, len(unprocessed))
	for _, note := range unprocessed {
		noteID := note["id"]
		noteIDStr := kbRecordIDString(noteID)
		itemErr := func() error {
			uid := kbJSOr(mapStr(note, "user_id"), "guest") // note.user_id || 'guest'
			text := kbRecordText(note)

			if kbTrimmedLen(text) < 5 {
				_, uErr := client.From(db.TableStudyNotes).Eq("id", noteIDStr).
					Update(r.Context(), map[string]any{
						"ai_processed":   true,
						"papercore":      kbJSOr(text, ""),
						"logical_path":   "/未分类/",
						"process_status": "processed",
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return netErr
				}
				results = append(results, map[string]any{"id": noteID, "status": "skipped"})
				return nil
			}

			hierarchy, err := kbGetExistingTagHierarchy(r.Context(), client, uid)
			if err != nil {
				return err
			}
			papercore := kbGeneratePapercore(r.Context(), text, mapStr(note, "title"), "")
			result, gErr := kbGenerateHierarchicalTags(r.Context(), client, papercore,
				kbUTF16Len(text), hierarchy, uid)
			if gErr != nil {
				return gErr
			}
			logicalPaths := kbBuildLogicalPaths(result.L1, result.L2, result.Tags)
			hierarchicalTags := kbFilterEmpty(append([]string{result.L1, result.L2}, result.Tags...))

			_, uErr := client.From(db.TableStudyNotes).Eq("id", noteIDStr).
				Update(r.Context(), map[string]any{
					"tags":                 hierarchicalTags,
					"papercore":            papercore,
					"logical_path":         kbJSONStringify(logicalPaths),
					"ai_processed":         true,
					"process_status":       "processed",
					"viewed_after_process": false,
					"updated_at":           jsNowISO(),
				})
			if netErr := kbSwallowPostgrest(uErr); netErr != nil {
				return netErr
			}
			results = append(results, map[string]any{
				"id":           noteID,
				"status":       "processed",
				"tags":         hierarchicalTags,
				"logical_path": logicalPaths,
			})
			return nil
		}()

		if itemErr == nil {
			continue
		}
		log.Printf("Failed to process study note %v: %v", noteID, itemErr)
		if _, uErr := client.From(db.TableStudyNotes).Eq("id", noteIDStr).
			Update(r.Context(), map[string]any{"process_status": "failed"}); uErr != nil {
			// TS：失败标记自身抛错 → 外层 catch → 500（响应体为该错误）
			Error(w, http.StatusInternalServerError, uErr.Error())
			return
		}
		results = append(results, map[string]any{"id": noteID, "status": "error", "error": itemErr.Error()})
	}

	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	OK(w, results)
}

// handleKnowledgeBuilderProcessMaterials 批处理资料。
// 对应 knowledge-builder.ts:1521-1640。
func handleKnowledgeBuilderProcessMaterials(w http.ResponseWriter, r *http.Request) {
	userId := auth.UserID(r.Context()) // TS 不兜底 'guest'
	client, ok := dbClient(w)
	if !ok {
		return
	}

	query := client.From(db.TableMaterials).Select("*").
		Eq("ai_processed", "false").Order("created_at", false).Limit(10)
	// 多用户安全：仅处理本人记录（guest 保持旧行为）
	if uid, scoped := scopedUserID(userId); scoped {
		query = query.Eq("user_id", uid)
	}
	rows, err := query.Rows(r.Context())
	if err != nil {
		log.Printf("Process materials error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var unprocessed []map[string]any
	if err := json.Unmarshal(rows, &unprocessed); err != nil {
		unprocessed = nil
	}
	if len(unprocessed) == 0 {
		JSON(w, http.StatusOK, map[string]any{"data": []any{}, "message": "No unprocessed materials"})
		return
	}

	results := make([]map[string]any, 0, len(unprocessed))
	for _, material := range unprocessed {
		matID := material["id"]
		matIDStr := kbRecordIDString(matID)
		itemErr := func() error {
			uid := kbJSOr(mapStr(material, "user_id"), "guest")

			// Try disk first, fallback to DB
			var text string
			diskText := kbReadMaterialFileFromDisk(material)
			if diskText != "" && kbTrimmedLen(diskText) >= 5 {
				text = kbStripTOC(diskText)
			} else {
				text = kbRecordText(material)
			}

			if kbTrimmedLen(text) < 5 {
				_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).
					Update(r.Context(), map[string]any{
						"ai_processed":   true,
						"papercore":      kbJSOr(text, ""),
						"logical_path":   "/未分类/",
						"process_status": "processed",
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return netErr
				}
				results = append(results, map[string]any{"id": matID, "status": "skipped"})
				return nil
			}

			name := mapStr(material, "name")
			if !extracttext.IsReadableText(text) {
				degradedPapercore := kbBuildDegradedPapercore(name, "")
				// 与 process-content 的 forced-degraded 路径一致：保留用户设置的 logical_path
				userPath := kbUserSetLogicalPath(material)
				logicalPath := kbJSONStringify([]string{"/未分类/"})
				if userPath != "" {
					logicalPath = userPath
				}
				_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).
					Update(r.Context(), map[string]any{
						"ai_processed":   true,
						"papercore":      degradedPapercore,
						"logical_path":   logicalPath,
						"process_status": "processed",
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return netErr
				}
				results = append(results, map[string]any{
					"id":        matID,
					"status":    "processed",
					"papercore": degradedPapercore,
					"reason":    "degraded",
				})
				return nil
			}

			hierarchy, err := kbGetExistingTagHierarchy(r.Context(), client, uid)
			if err != nil {
				return err
			}
			papercore := kbGeneratePapercore(r.Context(), text, name, "")
			result, gErr := kbGenerateHierarchicalTags(r.Context(), client, papercore,
				kbUTF16Len(text), hierarchy, uid)
			if gErr != nil {
				return gErr
			}
			logicalPaths := kbBuildLogicalPaths(result.L1, result.L2, result.Tags)
			hierarchicalTags := kbFilterEmpty(append([]string{result.L1, result.L2}, result.Tags...))

			_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).
				Update(r.Context(), map[string]any{
					"tags":                 hierarchicalTags,
					"papercore":            papercore,
					"logical_path":         kbJSONStringify(logicalPaths),
					"ai_processed":         true,
					"process_status":       "processed",
					"viewed_after_process": false,
					"updated_at":           jsNowISO(),
				})
			if netErr := kbSwallowPostgrest(uErr); netErr != nil {
				return netErr
			}
			results = append(results, map[string]any{
				"id":           matID,
				"status":       "processed",
				"tags":         hierarchicalTags,
				"logical_path": logicalPaths,
			})
			return nil
		}()

		if itemErr == nil {
			continue
		}
		log.Printf("Failed to process material %v: %v", matID, itemErr)
		if _, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).
			Update(r.Context(), map[string]any{"process_status": "failed"}); uErr != nil {
			Error(w, http.StatusInternalServerError, uErr.Error())
			return
		}
		results = append(results, map[string]any{"id": matID, "status": "error", "error": itemErr.Error()})
	}

	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	OK(w, results)
}
