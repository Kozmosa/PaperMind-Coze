package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
)

// ── POST /trigger（knowledge-builder.ts:2198-2221）───────────────────
// 统计未处理记录数。注意 TS 无 user_id 过滤（全库计数），保持原样。

func handleKnowledgeBuilderTrigger(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	countIDs := func(table string) (int, error) {
		rows, err := client.From(table).Select("id").Eq("ai_processed", "false").Limit(100).Rows(r.Context())
		if netErr := kbSwallowPostgrest(err); netErr != nil {
			return 0, netErr
		}
		var ids []map[string]any
		if jsonErr := json.Unmarshal(rows, &ids); jsonErr != nil {
			ids = nil
		}
		return len(ids), nil
	}
	noteCount, err := countIDs(db.TableStudyNotes)
	if err != nil {
		log.Printf("trigger error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	materialCount, err := countIDs(db.TableMaterials)
	if err != nil {
		log.Printf("trigger error: %v", err)
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	OK(w, struct {
		UnprocessedStudyNotes int `json:"unprocessedStudyNotes"`
		UnprocessedMaterials  int `json:"unprocessedMaterials"`
		Total                 int `json:"total"`
	}{noteCount, materialCount, noteCount + materialCount})
}

// ── 标签归并（knowledge-builder.ts:2228-2378）───────────────────────
// 仅 LLM 同义词检测 + 程序化子串/已知同义词对；不合并相关但不同的概念。

// kbMergeEntry 是 merged 数组元素（{tag, into, level}）。
type kbMergeEntry struct {
	Tag   string `json:"tag"`
	Into  string `json:"into"`
	Level string `json:"level"`
}

// kbApplyMerge 复刻 applyMerge（:2238-2270）：两表全量读取，from → to
// 替换 + **相邻去重**，logical_path 逐条替换首个 /from/ 段后落库。
func kbApplyMerge(ctx context.Context, client *db.Client, userID, from, to string) error {
	if from == to {
		return nil
	}
	for _, table := range []string{db.TableStudyNotes, db.TableMaterials} {
		records, err := kbSelectMaps(ctx, client, table, "id, tags, logical_path", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID)
		})
		if err != nil {
			return err
		}
		for _, rec := range records {
			tags := kbStringSlice(rec["tags"])
			updated := make([]string, len(tags))
			for i, t := range tags {
				if t == from {
					updated[i] = to
				} else {
					updated[i] = t
				}
			}
			deduped := kbAdjacentDedup(updated)
			if strings.Join(deduped, ",") == strings.Join(tags, ",") {
				continue
			}
			rawPath := kbJSOr(mapStr(rec, "logical_path"), "[]") // r.logical_path || '[]'
			paths := kbParsePathsOrLegacy(rawPath)
			_, uErr := client.From(table).Eq("id", kbRecordIDString(rec["id"])).
				Update(ctx, map[string]any{
					"tags":         deduped,
					"logical_path": kbJSONStringify(kbReplaceTagInPaths(paths, from, to)),
				})
			if netErr := kbSwallowPostgrest(uErr); netErr != nil {
				return netErr
			}
		}
	}
	return nil
}

// kbKnownL2Synonyms 复刻已知 L2 同义词对（:2290-2295，embedding/子串
// 抓不住的）。
var kbKnownL2Synonyms = [][2]string{
	{"复变函数", "复分析"},
	{"抽样理论", "统计学"},
	{"数理统计", "统计学"},
	{"最优化方法", "运筹学"},
}

// kbConsolidateTags 复刻 consolidateTags（:2228-2378）：L2 子串归并 →
// 已知同义词对 → LLM 同义词归并。返回 merged 列表；网络/DB 网络错误
// 上抛（TS 会 reject 进路由 catch → 500），LLM 错误吞掉。
func kbConsolidateTags(ctx context.Context, client *db.Client, userID string) ([]kbMergeEntry, error) {
	hierarchy, err := kbGetExistingTagHierarchy(ctx, client, userID)
	if err != nil {
		return nil, err
	}
	merged := []kbMergeEntry{}
	if len(hierarchy.L2) <= 1 {
		return merged, nil
	}

	// L2-level programmatic dedup before LLM
	// Substring match: if one L2 name is contained in another → merge shorter into longer
	l2Tags := append([]string{}, hierarchy.L2...)
	// JS sort((a, b) => b.length - a.length)：稳定，按长度降序
	sort.SliceStable(l2Tags, func(i, j int) bool {
		return kbUTF16Len(l2Tags[i]) > kbUTF16Len(l2Tags[j])
	})
	for i := 0; i < len(l2Tags); i++ {
		for j := i + 1; j < len(l2Tags); j++ {
			longer, shorter := l2Tags[i], l2Tags[j]
			if longer != shorter && strings.Contains(longer, shorter) && kbUTF16Len(shorter) >= 2 {
				log.Printf("[consolidate] substring merge: %q → %q", shorter, longer)
				if err := kbApplyMerge(ctx, client, userID, shorter, longer); err != nil {
					return nil, err
				}
				merged = append(merged, kbMergeEntry{Tag: shorter, Into: longer, Level: "L2"})
				hierarchy.removeL2(shorter)
			}
		}
	}

	// Known L2 synonym pairs (embedding/substring can't catch)
	for _, pair := range kbKnownL2Synonyms {
		from, to := pair[0], pair[1]
		if kbContains(hierarchy.L2, from) && kbContains(hierarchy.L2, to) {
			log.Printf("[consolidate] known synonym: %q → %q", from, to)
			if err := kbApplyMerge(ctx, client, userID, from, to); err != nil {
				return nil, err
			}
			merged = append(merged, kbMergeEntry{Tag: from, Into: to, Level: "L2"})
			hierarchy.removeL2(from)
		}
	}

	// Build L2→L3s mapping for cross-L2 L3 dedup
	fetchTags := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null")
		})
	}
	notes2, err := fetchTags(db.TableStudyNotes)
	if err != nil {
		return nil, err
	}
	materials2, err := fetchTags(db.TableMaterials)
	if err != nil {
		return nil, err
	}
	l2ToL3s := map[string]map[string]bool{}
	for _, r := range append(append([]map[string]any{}, notes2...), materials2...) {
		tags, ok := r["tags"].([]any)
		if !ok || len(tags) < 3 {
			continue
		}
		l2 := kbJSString(tags[1])
		if l2 == "" {
			continue
		}
		if l2ToL3s[l2] == nil {
			l2ToL3s[l2] = map[string]bool{}
		}
		for _, t := range tags[2:] {
			if s := kbJSString(t); s != "" {
				l2ToL3s[l2][s] = true
			}
		}
	}

	// --- LLM consolidation: L2 synonyms + cross-L2 L3 dedup ---
	var l2Only []string
	for _, l2 := range hierarchy.L2 {
		if l2 != "" {
			l2Only = append(l2Only, l2)
		}
	}
	if len(l2Only) > 1 {
		// Build compact representation: each L2 with its top L3s (max 8 per L2)
		summaryLines := make([]string, len(l2Only))
		for i, l2 := range l2Only {
			l3s := make([]string, 0, 8)
			for l3 := range l2ToL3s[l2] { // Set 迭代序无关紧要（进 prompt）
				l3s = append(l3s, l3)
				if len(l3s) >= 8 {
					break
				}
			}
			summaryLines[i] = fmt.Sprintf("%q → [%s]", l2, strings.Join(l3s, ", "))
		}
		prompt := fmt.Sprintf(`你是学科分类与标签去重专家。分析以下二级学科(L2)及其包含的章节(L3)：

%s

任务：
1. 找出含义相同、仅是不同叫法的L2标签对（如"复分析"="复变函数"）
2. 如果两个L2下有大量相同/同义的L3，应合并这两个L2
3. 不要合并不同的子学科

输出JSON数组（没有则[]）：
[{"merge":"被合并标签", "into":"保留标签", "level":"L2"}]`, strings.Join(summaryLines, "\n"))

		content, llmErr := kbLLMText(ctx, prompt, 8192, 0.1)
		if llmErr != nil {
			log.Printf("consolidateTags LLM error: %v", llmErr)
			content = ""
		}
		if m, ok := kbExtractJSONArray(content); ok {
			var pairs []map[string]any
			if jsonErr := json.Unmarshal([]byte(m), &pairs); jsonErr == nil {
				for _, pair := range pairs {
					merge, mergeOk := pair["merge"].(string)
					into, intoOk := pair["into"].(string)
					if mergeOk && intoOk && merge == into {
						continue
					}
					level, _ := pair["level"].(string)
					if level == "" {
						level = "L2"
					}
					// hierarchy[level]?.includes(pair.merge)：非字符串或未知
					// level（L1/L2/L3 以外）在 TS 均为 undefined → continue
					exists := false
					switch level {
					case "L1":
						exists = mergeOk && kbContains(hierarchy.L1, merge)
					case "L2":
						exists = mergeOk && kbContains(hierarchy.L2, merge)
					case "L3":
						exists = mergeOk && kbContains(hierarchy.L3, merge)
					}
					if !exists {
						continue
					}
					log.Printf("[consolidate] LLM merge: %q → %q (%s)", merge, into, level)
					if err := kbApplyMerge(ctx, client, userID, merge, into); err != nil {
						return nil, err
					}
					merged = append(merged, kbMergeEntry{Tag: merge, Into: into, Level: level})
					hierarchy.removeL2(merge) // TS：无论 level 都从 L2 移除
				}
			}
		}
	}

	return merged, nil
}

// handleKnowledgeBuilderConsolidateTags 标签归并路由。
// 对应 knowledge-builder.ts:2894-2904。
func handleKnowledgeBuilderConsolidateTags(w http.ResponseWriter, r *http.Request) {
	userID := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}
	merged, err := kbConsolidateTags(r.Context(), client, userID)
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	message := "无需合并"
	if len(merged) > 0 {
		message = fmt.Sprintf("合并 %d 组", len(merged))
	}
	OK(w, struct {
		Merged  []kbMergeEntry `json:"merged"`
		Message string         `json:"message"`
	}{merged, message})
}

// ── POST /rebuild-all（knowledge-builder.ts:2383-2889）───────────────
// 重置并全量重处理：动态层级（每份文件处理完即并入 existingHierarchy，
// 后面的文件能继承前面的标签）→ L2 重指派 pass（用完整最终树复判）→
// 不可读扫描件按课程批处理 → consolidateTags → 课程 L3 合并。

// handleKnowledgeBuilderRebuildAll 全量重建。
// 对应 knowledge-builder.ts:2383-2889。
func handleKnowledgeBuilderRebuildAll(w http.ResponseWriter, r *http.Request) {
	userID := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}

	data, status, resp := func() (map[string]any, int, any) {
		// TS/Express 无请求取消语义：客户端断开后重处理循环仍执行到底
		// （knowledge-builder.ts:2383-2889 无任何取消机制）。此处必须用独立
		// ctx——若绑 r.Context()，断连会让「已清空两表、尚未回写」之后的所有
		// Update 变 context canceled，用户数据停留在被清空的中间态。
		ctx := context.Background()
		// 1. 重置两表（TS 未解构错误 → 全吞；网络错误会 reject → 500）
		for _, table := range []string{db.TableStudyNotes, db.TableMaterials} {
			_, err := client.From(table).Eq("user_id", userID).Update(ctx, map[string]any{
				"ai_processed": false, "papercore": "", "tags": []any{}, "logical_path": "",
			})
			if netErr := kbSwallowPostgrest(err); netErr != nil {
				return nil, http.StatusInternalServerError, map[string]any{"error": netErr.Error()}
			}
		}

		// 2. 全量读取（created_at 倒序，无 limit）
		fetchAll := func(table string) ([]map[string]any, error) {
			return kbSelectMaps(ctx, client, table, "*", func(q *db.Query) *db.Query {
				return q.Eq("user_id", userID).Order("created_at", false)
			})
		}
		notes, err := fetchAll(db.TableStudyNotes)
		if err != nil {
			return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		materials, err := fetchAll(db.TableMaterials)
		if err != nil {
			return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}

		processed := 0
		errEntries := []map[string]any{}
		// Dynamic hierarchy: update after each file so later files can inherit earlier files' tags
		existingHierarchy, err := kbGetExistingTagHierarchy(ctx, client, userID)
		if err != nil {
			return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		updateHierarchy := func(l1, l2 string, l3s []string) {
			existingHierarchy.addL1(l1)
			existingHierarchy.addL2(l2)
			for _, kp := range l3s {
				existingHierarchy.addL3(kp)
			}
		}

		perFileLog := []map[string]any{}

		// ── 学习纪要循环（:2429-2481）──
		for _, note := range notes {
			noteID := note["id"]
			noteIDStr := kbRecordIDString(noteID)
			entry, cont, pErr := func() (map[string]any, bool, error) {
				text := kbRecordText(note)
				if text == "" || kbTrimmedLen(text) < 5 {
					_, uErr := client.From(db.TableStudyNotes).Eq("id", noteIDStr).Eq("user_id", userID).
						Update(ctx, map[string]any{
							"ai_processed": true, "papercore": kbJSOr(text, ""), "logical_path": "/未分类/",
						})
					if netErr := kbSwallowPostgrest(uErr); netErr != nil {
						return nil, false, netErr
					}
					return nil, true, nil // skipped：TS 不写 perFileLog，只 processed++
				}
				noteFileName := mapStr(note, "title")
				papercore := kbGeneratePapercore(ctx, text, noteFileName, "")
				result, gErr := kbGenerateHierarchicalTags(ctx, client, papercore, kbUTF16Len(text), existingHierarchy, userID)
				if gErr != nil {
					return nil, false, gErr
				}
				logicalPaths := kbBuildLogicalPaths(result.L1, result.L2, result.Tags)
				_, uErr := client.From(db.TableStudyNotes).Eq("id", noteIDStr).Eq("user_id", userID).
					Update(ctx, map[string]any{
						"tags":                 kbFilterEmpty(append([]string{result.L1, result.L2}, result.Tags...)),
						"papercore":            papercore,
						"logical_path":         kbJSONStringify(logicalPaths),
						"ai_processed":         true,
						"viewed_after_process": false,
						"updated_at":           jsNowISO(),
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return nil, false, netErr
				}
				return map[string]any{
					"id":        noteID,
					"name":      kbJSOr(mapStr(note, "name"), kbJSSlice(kbJSOr(mapStr(note, "content"), ""), 0, 40)),
					"type":      "study_note",
					"L1":        result.L1,
					"L2":        result.L2,
					"L3s":       orEmptyStrings(result.Tags),
					"papercore": kbJSSlice(papercore, 0, 100),
					"paths":     logicalPaths,
				}, false, nil
			}()
			if pErr != nil {
				errEntries = append(errEntries, map[string]any{
					"id": noteID, "type": "study_note", "error": pErr.Error(),
				})
				continue
			}
			if cont {
				processed++
				continue
			}
			updateHierarchy(mapStr(entry, "L1"), mapStr(entry, "L2"), kbStringSlice(entry["L3s"]))
			perFileLog = append(perFileLog, entry)
			processed++
		}

		// ── 资料循环（:2483-2582）──
		for _, material := range materials {
			matID := material["id"]
			matIDStr := kbRecordIDString(matID)
			name := mapStr(material, "name")
			matName := name
			entry, cont, mErr := func() (map[string]any, bool, error) {
				var text string
				diskText := kbReadMaterialFileFromDisk(material)
				if diskText != "" && kbTrimmedLen(diskText) >= 5 {
					text = kbStripTOC(diskText)
				} else {
					text = kbRecordText(material)
				}

				if text == "" || kbTrimmedLen(text) < 5 {
					_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).Eq("user_id", userID).
						Update(ctx, map[string]any{
							"ai_processed": true, "papercore": kbJSOr(text, ""), "logical_path": "/未分类/",
						})
					if netErr := kbSwallowPostgrest(uErr); netErr != nil {
						return nil, false, netErr
					}
					return nil, true, nil // skipped（TS 不写 perFileLog）
				}
				if !extracttext.IsReadableText(text) {
					// 不可读扫描件：命中课程映射的延迟到批处理强制分类
					courseIdx := -1
					for i := range kbUnreadableFileCourseMap {
						if kbUnreadableFileCourseMap[i].Pattern.MatchString(matName) {
							courseIdx = i
							break
						}
					}
					if courseIdx >= 0 {
						return map[string]any{
							"id": matID, "name": kbJSSlice(matName, 0, 60), "type": "material",
							"L1": "", "L2": "", "L3s": []string{}, "papercore": "", "paths": []string{},
							"skipped": fmt.Sprintf("degraded_course_%d", courseIdx),
						}, false, nil
					}
					degradedPapercore := kbBuildDegradedPapercore(matName, "")
					_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).Eq("user_id", userID).
						Update(ctx, map[string]any{
							"ai_processed": true, "papercore": degradedPapercore,
							"logical_path": kbJSONStringify([]string{"/未分类/"}),
						})
					if netErr := kbSwallowPostgrest(uErr); netErr != nil {
						return nil, false, netErr
					}
					return map[string]any{
						"id": matID, "name": kbJSSlice(matName, 0, 60), "type": "material",
						"L1": "", "L2": "", "L3s": []string{},
						"papercore": kbJSSlice(degradedPapercore, 0, 120), "paths": []string{"/未分类/"},
						"skipped": "degraded",
					}, false, nil
				}
				papercore := kbGeneratePapercore(ctx, text, name, "")
				result, gErr := kbGenerateHierarchicalTags(ctx, client, papercore, kbUTF16Len(text), existingHierarchy, userID)
				if gErr != nil {
					return nil, false, gErr
				}
				logicalPaths := kbBuildLogicalPaths(result.L1, result.L2, result.Tags)
				_, uErr := client.From(db.TableMaterials).Eq("id", matIDStr).Eq("user_id", userID).
					Update(ctx, map[string]any{
						"tags":                 kbFilterEmpty(append([]string{result.L1, result.L2}, result.Tags...)),
						"papercore":            papercore,
						"logical_path":         kbJSONStringify(logicalPaths),
						"ai_processed":         true,
						"viewed_after_process": false,
						"updated_at":           jsNowISO(),
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return nil, false, netErr
				}
				entry := map[string]any{
					"id": matID, "type": "material",
					"L1": result.L1, "L2": result.L2, "L3s": orEmptyStrings(result.Tags),
					"papercore": kbJSSlice(papercore, 0, 120), "paths": logicalPaths,
				}
				if name != "" { // TS：material.name?.slice(0,60)——无 name 时键不存在
					entry["name"] = kbJSSlice(name, 0, 60)
				}
				return entry, false, nil
			}()
			if mErr != nil {
				errEntries = append(errEntries, map[string]any{
					"id": matID, "type": "material", "error": mErr.Error(),
				})
				continue
			}
			if cont {
				processed++
				continue
			}
			if entry["skipped"] == nil {
				updateHierarchy(mapStr(entry, "L1"), mapStr(entry, "L2"), kbStringSlice(entry["L3s"]))
			} else {
				// 命中课程映射的 skipped 条目：层级并入延迟到批处理 pass
			}
			perFileLog = append(perFileLog, entry)
			processed++
		}

		// ── L2 重指派 pass（:2584-2704）──
		finalTree, err := kbBuildL1L2Tree(ctx, client, userID)
		if err != nil {
			return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}
		finalTreeText := kbFormatL1L2Tree(finalTree)
		finalL1s := finalTree.keys()
		var finalL2s []string
		for _, l1 := range finalL1s {
			finalL2s = append(finalL2s, finalTree.l2s(l1)...)
		}
		log.Printf("[l2-reassign] Final tree: %d L1s, %d L2s — %s",
			len(finalL1s), len(finalL2s), strings.ReplaceAll(finalTreeText, "\n", " | "))

		reassigned := 0
		for _, entry := range perFileLog {
			oldL2 := mapStr(entry, "L2")
			papercore := mapStr(entry, "papercore")
			if papercore == "" ||
				strings.HasPrefix(papercore, "该文档以公式") ||
				strings.HasPrefix(papercore, "该文档因严重编码") {
				continue
			}
			if mapStr(entry, "L1") == "" || oldL2 == "" {
				continue
			}

			reassignPrompt := fmt.Sprintf(`你是学科分类专家。以下是完整的学科树和一份文档。请判断此文档的L2归属是否需要修正。

完整学科树：
%s

文档当前分类：%s > %s
文档摘要：
%s

规则：
1. 如果当前L2已经是该文档最佳归属，输出不变
2. 如果有更合适的L2（学科树中已存在），输出修正后的L2
3. L1同理：如果当前L1不匹配学科树中的L1，修正之
4. L1/L2名称必须与学科树中完全一致

输出JSON：{"L1":"...", "L2":"...", "changed":true/false, "reasoning":"..."}`,
				finalTreeText, mapStr(entry, "L1"), oldL2, kbJSSlice(papercore, 0, 600))

			c2, llmErr := kbLLMText(ctx, reassignPrompt, 8192, 0.2)
			if llmErr != nil {
				// Individual reassign failures are non-fatal
				log.Printf("[l2-reassign] Error for %v: %v", kbJSOr(mapStr(entry, "name"), kbRecordIDString(entry["id"])), llmErr)
				continue
			}
			m2, ok := pslExtractJSONObject(c2)
			if !ok {
				continue
			}
			var parsed map[string]any
			if jsonErr := json.Unmarshal([]byte(m2), &parsed); jsonErr != nil {
				continue
			}
			// (parsed.L1 || entry.L1).trim()——非字符串按 TS 会 throw 进 catch，此处跳过
			newL1, okL1 := parsed["L1"].(string)
			if !okL1 || newL1 == "" {
				newL1 = mapStr(entry, "L1")
			} else {
				newL1 = kbJSTrim(newL1)
			}
			newL2, okL2 := parsed["L2"].(string)
			if !okL2 || newL2 == "" {
				newL2 = oldL2
			} else {
				newL2 = kbJSTrim(newL2)
			}
			if kbInvalidTagSet[newL1] || kbInvalidTagSet[newL2] {
				continue
			}

			// Validate against final tree
			validL1 := newL1
			if !kbContains(finalL1s, newL1) {
				if kbContains(finalL1s, mapStr(entry, "L1")) {
					validL1 = mapStr(entry, "L1")
				} else if len(finalL1s) > 0 {
					validL1 = finalL1s[0]
				} else {
					validL1 = ""
				}
			}
			validL2, validL2Set := newL2, false
			if !kbContains(finalL2s, newL2) && !finalTree.has(validL1, newL2) {
				if kbContains(finalL2s, oldL2) {
					validL2, validL2Set = oldL2, true
				} else if l2s := finalTree.l2s(validL1); len(l2s) > 0 {
					validL2, validL2Set = l2s[0], true
				}
			} else {
				validL2Set = true
			}

			if validL2Set && validL2 != "" && validL2 != oldL2 {
				reasoning, _ := parsed["reasoning"].(string)
				if reasoning == "" {
					reasoning = "no reason"
				}
				log.Printf("[l2-reassign] %v: %q → %q | %s",
					kbJSOr(mapStr(entry, "name"), kbRecordIDString(entry["id"])), oldL2, validL2, reasoning)

				table := db.TableMaterials
				if mapStr(entry, "type") == "study_note" {
					table = db.TableStudyNotes
				}
				l3s := kbStringSlice(entry["L3s"])
				newTags := kbFilterEmpty(append([]string{validL1, validL2}, l3s...))
				newLogicalPaths := kbBuildLogicalPaths(validL1, validL2, l3s)
				_, uErr := client.From(table).Eq("id", kbRecordIDString(entry["id"])).Eq("user_id", userID).
					Update(ctx, map[string]any{
						"tags":         newTags,
						"logical_path": kbJSONStringify(newLogicalPaths),
						"updated_at":   jsNowISO(),
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					return nil, http.StatusInternalServerError, map[string]any{"error": netErr.Error()}
				}

				// Update perFileLog
				entry["L1"] = validL1
				entry["L2"] = validL2
				entry["paths"] = newLogicalPaths
				entry["reassigned"] = true
				reassigned++
			}
		}

		log.Printf("[l2-reassign] Complete: %d documents reassigned", reassigned)

		// ── 不可读扫描件批处理（:2706-2788，按课程逐课程强制分类）──
		for ci := range kbUnreadableFileCourseMap {
			course := &kbUnreadableFileCourseMap[ci]
			var courseEntries []map[string]any
			for _, e := range perFileLog {
				if s, ok := e["skipped"].(string); ok && s == fmt.Sprintf("degraded_course_%d", ci) {
					courseEntries = append(courseEntries, e)
				}
			}
			if len(courseEntries) == 0 {
				continue
			}

			log.Printf("[course-batch] Processing %d unreadable files for %s > %s...",
				len(courseEntries), course.L1, course.L2)
			existingL3s, err := kbGetAllL3NamesUnderL2(ctx, client, userID, course.L1, course.L2)
			if err != nil {
				return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
			}
			existingText := strings.Join(existingL3s, ", ")
			if existingText == "" {
				existingText = "(尚无)"
			}
			filenames := make([]string, len(courseEntries))
			for i, e := range courseEntries {
				filenames[i] = mapStr(e, "name")
			}

			coursePrompt := fmt.Sprintf(`你是%s课程专家。以下是一批%s课程PDF的文件名，由于PDF编码问题无法提取文本，请根据文件名推断每个文件的核心话题。

文件名列表：
%s

%s下已有L3标签：%s

标准课程体系参考：%s。

规则：
1. %s
2. L3标签必须使用大类名称，优先复用已有标签
3. 同模块不同周可能有不同话题，请区分
4. 每个文件最多3个L3标签

输出JSON数组：
[{"filename":"...", "topic":"简要话题描述", "l3s":["大类标签1","大类标签2"]}, ...]`,
				course.L2, course.L2, strings.Join(filenames, "\n"), course.L2,
				existingText, course.CourseSystem, course.TopicHint)

			content, llmErr := kbLLMText(ctx, coursePrompt, 8192, 0.3)
			if llmErr != nil {
				log.Printf("[course-batch] %s batch LLM error: %v", course.L2, llmErr)
				continue
			}
			m, ok := kbExtractJSONArray(content)
			if !ok {
				continue
			}
			var parsed []map[string]any
			if jsonErr := json.Unmarshal([]byte(m), &parsed); jsonErr != nil {
				continue
			}
			for _, item := range parsed {
				filename, _ := item["filename"].(string)
				var logEntry map[string]any
				for _, e := range courseEntries {
					if mapStr(e, "name") == filename {
						logEntry = e
						break
					}
				}
				if logEntry == nil {
					continue
				}
				// (entry.l3s || []).slice(0, 3)：非字符串元素以 JS 字面量拼入
				l3s := []string{}
				if arr, ok := item["l3s"].([]any); ok {
					for i, t := range arr {
						if i >= 3 {
							break
						}
						l3s = append(l3s, kbJSString(t))
					}
				}
				papercore, _ := item["topic"].(string)
				if papercore == "" {
					papercore = fmt.Sprintf("%s课程：%s", course.L2, filename)
				}
				logicalPaths := kbBuildLogicalPaths(course.L1, course.L2, l3s)

				_, uErr := client.From(db.TableMaterials).
					Eq("id", kbRecordIDString(logEntry["id"])).Eq("user_id", userID).
					Update(ctx, map[string]any{
						"tags":         kbFilterEmpty(append([]string{course.L1, course.L2}, l3s...)),
						"papercore":    papercore,
						"logical_path": kbJSONStringify(logicalPaths),
						"ai_processed": true,
						"updated_at":   jsNowISO(),
					})
				if netErr := kbSwallowPostgrest(uErr); netErr != nil {
					log.Printf("[course-batch] update error: %v", netErr) // TS 未解构错误，吞掉
				}

				logEntry["L1"] = course.L1
				logEntry["L2"] = course.L2
				logEntry["L3s"] = l3s
				logEntry["papercore"] = kbJSSlice(papercore, 0, 120)
				logEntry["paths"] = logicalPaths
				delete(logEntry, "skipped")
				logEntry["forced"] = true
				updateHierarchy(course.L1, course.L2, l3s)
				log.Printf("[course-batch] %s: %s", filename, strings.Join(l3s, ", "))
			}
		}

		merged, err := kbConsolidateTags(ctx, client, userID)
		if err != nil {
			return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
		}

		// ── 课程 L3 合并（:2792-2873，把细碎 L3 合并为宽类别）──
		for ci := range kbUnreadableFileCourseMap {
			course := &kbUnreadableFileCourseMap[ci]
			courseL3s, err := kbGetAllL3NamesUnderL2(ctx, client, userID, course.L1, course.L2)
			if err != nil {
				return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
			}
			if len(courseL3s) <= 3 {
				continue
			}
			log.Printf("[l3-consolidate] %s has %d L3s, checking consolidation...", course.L2, len(courseL3s))

			l3ConsolidatePrompt := fmt.Sprintf(`你是%s标签管理专家。以下是%s下的所有L3标签，其中有些过于细碎，需合并为更宽的类别。

当前L3标签（%d个）：
%s

规则：
1. 细碎标签合并：将过细的子标签合并到其所属的大类
2. 保留核心大类独立
3. 不合并不同学科方向
4. 若标签已是合适的大类粒度则保留
5. %s标准大类参考：%s

输出JSON（无变化则[]）：
[{"merge":"细碎标签", "into":"大类标签"}, ...]`,
				course.L2, course.L2, len(courseL3s), strings.Join(courseL3s, "\n"),
				course.L2, course.CourseSystem)

			content, llmErr := kbLLMText(ctx, l3ConsolidatePrompt, 8192, 0.2)
			if llmErr != nil {
				log.Printf("[l3-consolidate] %s LLM error: %v", course.L2, llmErr)
				continue
			}
			m, ok := kbExtractJSONArray(content)
			if !ok {
				continue
			}
			var merges []map[string]any
			if jsonErr := json.Unmarshal([]byte(m), &merges); jsonErr != nil {
				continue
			}
			l3Merged := 0
			for _, pair := range merges {
				from, _ := pair["merge"].(string)
				to, _ := pair["into"].(string)
				if from == to || !kbContains(courseL3s, from) {
					continue
				}
				log.Printf("[l3-consolidate] %s L3: %q → %q", course.L2, from, to)
				for _, table := range []string{db.TableStudyNotes, db.TableMaterials} {
					records, err := kbSelectMaps(ctx, client, table, "id, tags, logical_path", func(q *db.Query) *db.Query {
						return q.Eq("user_id", userID)
					})
					if err != nil {
						return nil, http.StatusInternalServerError, map[string]any{"error": err.Error()}
					}
					for _, rec := range records {
						tags := kbStringSlice(rec["tags"])
						if len(tags) < 3 || tags[1] != course.L2 || !kbContains(tags, from) {
							continue
						}
						updated := make([]string, len(tags))
						for i, t := range tags {
							if t == from {
								updated[i] = to
							} else {
								updated[i] = t
							}
						}
						deduped := kbFirstOccurrenceDedup(updated)
						rawPath := kbJSOr(mapStr(rec, "logical_path"), "[]")
						paths := kbParsePathsOrLegacy(rawPath)
						_, uErr := client.From(table).Eq("id", kbRecordIDString(rec["id"])).
							Update(ctx, map[string]any{
								"tags":         deduped,
								"logical_path": kbJSONStringify(kbReplaceTagInPaths(paths, from, to)),
							})
						if netErr := kbSwallowPostgrest(uErr); netErr != nil {
							return nil, http.StatusInternalServerError, map[string]any{"error": netErr.Error()}
						}
					}
				}
				l3Merged++
			}
			if l3Merged > 0 {
				log.Printf("[l3-consolidate] %s: %d L3 merges completed", course.L2, l3Merged)
			}
		}

		total := len(notes) + len(materials)
		data := map[string]any{
			"total":      total,
			"processed":  processed,
			"merged":     merged,
			"reassigned": reassigned,
			"perFileLog": perFileLog,
		}
		if len(errEntries) > 0 {
			data["errors"] = errEntries // TS：errors.length > 0 ? errors : undefined（空时键不存在）
		}
		msg := fmt.Sprintf("%d/%d 处理", processed, total)
		if len(merged) > 0 {
			msg += fmt.Sprintf(", %d 组合并", len(merged))
		}
		if reassigned > 0 {
			msg += fmt.Sprintf(", %d 个重新分配L2", reassigned)
		}
		data["message"] = msg
		return data, 0, nil
	}()

	if status != 0 {
		JSON(w, status, resp)
		return
	}
	OK(w, data)
}

// ── POST /migrate-add-conflict-column（knowledge-builder.ts:2909-2958）──

// handleKnowledgeBuilderMigrateConflictColumn 补 embedding_conflict 列：
// 以 0 行 update 探测列是否存在，缺失时走 RPC add_embedding_conflict_column。
func handleKnowledgeBuilderMigrateConflictColumn(w http.ResponseWriter, r *http.Request) {
	client, ok := dbClient(w)
	if !ok {
		return
	}
	var results []string
	for _, table := range []string{db.TableStudyNotes, db.TableMaterials} {
		// per-table try/catch（:2915-2947）
		func() {
			defer func() {
				if e := recover(); e != nil {
					results = append(results, fmt.Sprintf("%s: check failed: %v", table, e))
				}
			}()
			_, err := client.From(table).
				Eq("id", "00000000-0000-0000-000000000000").
				Update(r.Context(), map[string]any{"embedding_conflict": false})
			if err == nil {
				results = append(results, table+": column already exists")
				return
			}
			pgCode := ""
			var pErr *db.PostgrestError
			if errors.As(err, &pErr) {
				pgCode = pErr.Code
			}
			if strings.Contains(dbErrorMessage(err), "embedding_conflict") || pgCode == "42703" {
				// Column doesn't exist — add it via raw SQL（supabase.rpc）
				if sqlErr := kbSupabaseRPC(r.Context(), "add_embedding_conflict_column",
					map[string]any{"table_name": table}); sqlErr != nil {
					// RPC not available, try direct approach
					results = append(results, fmt.Sprintf(
						"%s: column missing (run: ALTER TABLE %s ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE)",
						table, table))
				} else {
					results = append(results, table+": column added via RPC")
				}
			} else {
				results = append(results, fmt.Sprintf("%s: column exists or other error: %s", table, err.Error()))
			}
		}()
	}

	OK(w, struct {
		Results []string `json:"results"`
		Manual  string   `json:"manual"`
	}{results, "If column missing, run in Supabase SQL Editor: ALTER TABLE study_notes ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE; ALTER TABLE materials ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE;"})
}

// kbSupabaseRPC 复刻 supabase.rpc(fn, params)（:2927-2929）：
// POST {COZE_SUPABASE_URL}/rest/v1/rpc/{fn}。internal/db 未导出 RPC 入口
// 且为共享文件不可改，此处用 config 凭据自行组装同款请求
// （apikey + Bearer 均用 service role 优先，与 db.Client 的密钥选择一致）。
func kbSupabaseRPC(ctx context.Context, fn string, params map[string]any) error {
	cfg := config.Load()
	if cfg.CozeSupabaseURL == "" {
		return db.ErrNotConfigured
	}
	key := cfg.CozeSupabaseServiceRoleKe
	if key == "" {
		key = cfg.CozeSupabaseAnonKey
	}
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.CozeSupabaseURL+"/rest/v1/rpc/"+fn, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("apikey", key)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("rpc %s: HTTP %d: %s", fn, resp.StatusCode, kbJSSlice(string(data), 0, 300))
	}
	return nil
}
