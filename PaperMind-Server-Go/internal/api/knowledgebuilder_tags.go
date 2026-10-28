package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
)

// ── DB 标签层（层级提取 / L3 检索 / 知识节点同步 / 课程映射）────────

// kbSwallowPostgrest 复刻「只解构 data / 完全不解构」的 supabase 调用语义：
// PostgREST 业务错误（*db.PostgrestError）被吞（TS 侧 data 为 null → 调用方
// `|| []` 兜底），网络类错误上抛（postgrest-js 会 reject 进 catch → 500）。
func kbSwallowPostgrest(err error) error {
	var pErr *db.PostgrestError
	if err != nil && !errors.As(err, &pErr) {
		return err
	}
	return nil
}

// kbSelectMaps 执行 SELECT 并解为行数组。PostgREST 错误按空结果处理
// （kbSwallowPostgrest），网络错误返回。build 追加 eq/not/order/limit。
func kbSelectMaps(ctx context.Context, client *db.Client, table, cols string,
	build func(*db.Query) *db.Query) ([]map[string]any, error) {
	rows, err := build(client.From(table).Select(cols)).Rows(ctx)
	if err != nil {
		if netErr := kbSwallowPostgrest(err); netErr != nil {
			return nil, netErr
		}
		return nil, nil
	}
	var out []map[string]any
	if err := json.Unmarshal(rows, &out); err != nil {
		return nil, nil // 防御：平铺 Accept 下非数组理论不可达，与 TS 空 data 等价
	}
	return out, nil
}

// kbTagHierarchy 是 getExistingTagHierarchy 的返回（knowledge-builder.ts:98-147）：
// L1/L2/L3 各为去重的有序集合（JS Set 的插入序，Array.from 语义）。
// rebuild-all 的 updateHierarchy 会在处理中途追加（指针方法）。
type kbTagHierarchy struct {
	L1 []string
	L2 []string
	L3 []string
}

func (h *kbTagHierarchy) addL1(v string) {
	if v != "" && !kbContains(h.L1, v) {
		h.L1 = append(h.L1, v)
	}
}

func (h *kbTagHierarchy) addL2(v string) {
	if v != "" && !kbContains(h.L2, v) {
		h.L2 = append(h.L2, v)
	}
}

func (h *kbTagHierarchy) addL3(v string) {
	if v != "" && !kbContains(h.L3, v) {
		h.L3 = append(h.L3, v)
	}
}

// removeL2 复刻 hierarchy.L2 = hierarchy.L2.filter(t => t !== x)
// （consolidateTags 合并后即时移除）。
func (h *kbTagHierarchy) removeL2(x string) {
	out := h.L2[:0:0]
	for _, t := range h.L2 {
		if t != x {
			out = append(out, t)
		}
	}
	h.L2 = out
}

// kbGetExistingTagHierarchy 复刻 getExistingTagHierarchy（:98-147）：
// study_notes + materials 各取 tags（not null，limit 500），按
// [L1, L2, ...L3s] 层级展开；只有 Array.isArray 的 tags 参与。
func kbGetExistingTagHierarchy(ctx context.Context, client *db.Client, userID string) (*kbTagHierarchy, error) {
	fetch := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null").Limit(500)
		})
	}
	notes, err := fetch(db.TableStudyNotes)
	if err != nil {
		return nil, err
	}
	materials, err := fetch(db.TableMaterials)
	if err != nil {
		return nil, err
	}
	return kbHierarchyFromRows(append(append([]map[string]any{}, notes...), materials...)), nil
}

// kbHierarchyFromRows 是 getExistingTagHierarchy 的行循环（knowledge-builder.ts
// :110-147），抽出为纯函数供单测：tags=[]/长度 1 的行必须安全跳过
//（JS arr.slice(2) 的空数组语义，对拍实测曾因此 panic）。
func kbHierarchyFromRows(rows []map[string]any) *kbTagHierarchy {
	h := &kbTagHierarchy{}
	l1 := map[string]bool{}
	l2 := map[string]bool{}
	l3 := map[string]bool{}
	for _, r := range rows {
		tagArr, ok := r["tags"].([]any)
		if !ok {
			continue // TS 的 Array.isArray 守卫
		}
		if len(tagArr) >= 1 {
			if s := kbJSString(tagArr[0]); s != "" && !l1[s] {
				l1[s] = true
				h.L1 = append(h.L1, s)
			}
		}
		if len(tagArr) >= 2 {
			if s := kbJSString(tagArr[1]); s != "" && !l2[s] {
				l2[s] = true
				h.L2 = append(h.L2, s)
			}
		}
		// JS 的 arr.slice(2) 对 len<2 数组返回 []；Go 的 tagArr[2:] 会
		// panic（对拍实测：上传资料 tags=[] 直接击穿）。必须守卫。
		if len(tagArr) > 2 {
			for _, t := range tagArr[2:] {
				if s := kbJSString(t); s != "" && !l3[s] {
					l3[s] = true
					h.L3 = append(h.L3, s)
				}
			}
		}
	}
	return h
}

// kbL1L2Tree 是 buildL1L2Tree 的返回（:212-238）：L1 → L2 集合，
// 双层均保持插入序（JS Map/Set 语义，prompt 里的学科树文本依赖该顺序）。
type kbL1L2Tree struct {
	order []string
	m     map[string]map[string]bool
	l2Ord map[string][]string
}

func (t *kbL1L2Tree) add(l1, l2 string) {
	if t.m == nil {
		t.m = map[string]map[string]bool{}
		t.l2Ord = map[string][]string{}
	}
	if _, ok := t.m[l1]; !ok {
		t.m[l1] = map[string]bool{}
		t.order = append(t.order, l1)
	}
	if !t.m[l1][l2] {
		t.m[l1][l2] = true
		t.l2Ord[l1] = append(t.l2Ord[l1], l2)
	}
}

func (t *kbL1L2Tree) keys() []string { return t.order }

func (t *kbL1L2Tree) l2s(l1 string) []string { return t.l2Ord[l1] }

func (t *kbL1L2Tree) has(l1, l2 string) bool {
	return t.m != nil && t.m[l1] != nil && t.m[l1][l2]
}

func (t *kbL1L2Tree) size() int { return len(t.order) }

// kbBuildL1L2Tree 复刻 buildL1L2Tree（:212-238）：tags 长度 ≥2 且
// 前两段非空的行建立 L1→L2 边（limit 500）。
func kbBuildL1L2Tree(ctx context.Context, client *db.Client, userID string) (*kbL1L2Tree, error) {
	fetch := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null").Limit(500)
		})
	}
	notes, err := fetch(db.TableStudyNotes)
	if err != nil {
		return nil, err
	}
	materials, err := fetch(db.TableMaterials)
	if err != nil {
		return nil, err
	}
	tree := &kbL1L2Tree{}
	for _, r := range append(append([]map[string]any{}, notes...), materials...) {
		tags, ok := r["tags"].([]any)
		if !ok || len(tags) < 2 {
			continue
		}
		l1, ok1 := tags[0].(string)
		l2, ok2 := tags[1].(string)
		if ok1 && ok2 && l1 != "" && l2 != "" {
			tree.add(l1, l2)
		}
	}
	return tree, nil
}

// kbFormatL1L2Tree 复刻 formatL1L2Tree（:240-250）：`  L1\n    └─ L2`。
func kbFormatL1L2Tree(tree *kbL1L2Tree) string {
	if tree.size() == 0 {
		return ""
	}
	var lines []string
	for _, l1 := range tree.keys() {
		lines = append(lines, "  "+l1)
		for _, l2 := range tree.l2s(l1) {
			lines = append(lines, "    └─ "+l2)
		}
	}
	return strings.Join(lines, "\n")
}

// kbL3Papercore 是 L3 候选（名称 → papercore 摘要）。
type kbL3Papercore struct {
	Name      string
	Papercore string
}

// kbRankL3s 复刻 getTopL3sUnderL2 的打分排序段（:291-307）：L3 名与
// （去空白后的）L3 papercore 逐字符（码点）与 papercore 字符集比对计
// 重叠数，稳定降序取 topK，papercore 截 200 字。
func kbRankL3s(l3s []kbL3Papercore, papercore string, topK int) []kbL3Papercore {
	papercoreChars := map[rune]bool{}
	for _, r := range kbStripJSSpace(papercore) {
		papercoreChars[r] = true
	}
	type scoredEntry struct {
		entry kbL3Papercore
		score int
	}
	items := make([]scoredEntry, len(l3s))
	for i, e := range l3s {
		overlap := 0
		for _, r := range e.Name {
			if papercoreChars[r] {
				overlap++
			}
		}
		for _, r := range kbStripJSSpace(e.Papercore) {
			if papercoreChars[r] {
				overlap++
			}
		}
		items[i] = scoredEntry{entry: e, score: overlap}
	}
	// JS sort 稳定：等分保持输入（Map 插入）序
	sort.SliceStable(items, func(i, j int) bool { return items[i].score > items[j].score })
	if len(items) > topK {
		items = items[:topK]
	}
	out := make([]kbL3Papercore, len(items))
	for i, s := range items {
		out[i] = kbL3Papercore{Name: s.entry.Name, Papercore: kbJSSlice(s.entry.Papercore, 0, 200)}
	}
	return out
}

// kbGetTopL3sUnderL2 复刻 getTopL3sUnderL2（:256-308）：L1/L2 下的 L3
// 集合（首见 papercore 保留）按 papercore 字符重叠打分取 topK。
func kbGetTopL3sUnderL2(ctx context.Context, client *db.Client, userID, l1, l2, papercore string, topK int) ([]kbL3Papercore, error) {
	fetch := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags, papercore", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null").Limit(500)
		})
	}
	notes, err := fetch(db.TableStudyNotes)
	if err != nil {
		return nil, err
	}
	materials, err := fetch(db.TableMaterials)
	if err != nil {
		return nil, err
	}
	var order []string
	l3Set := map[string]string{} // l3_name → papercore（首见保留）
	for _, r := range append(append([]map[string]any{}, notes...), materials...) {
		tags, ok := r["tags"].([]any)
		if !ok || len(tags) < 3 {
			continue
		}
		if kbJSString(tags[0]) != l1 || kbJSString(tags[1]) != l2 {
			continue
		}
		for _, t := range tags[2:] {
			name := kbJSString(t)
			if name == "" {
				continue
			}
			if _, exists := l3Set[name]; !exists {
				pc, _ := r["papercore"].(string)
				l3Set[name] = pc // TS：r.papercore || ''
				order = append(order, name)
			}
		}
	}
	entries := make([]kbL3Papercore, len(order))
	for i, name := range order {
		entries[i] = kbL3Papercore{Name: name, Papercore: l3Set[name]}
	}
	return kbRankL3s(entries, papercore, topK), nil
}

// kbCountL3sUnderL2 复刻 countL3sUnderL2（:313-330）：统计 L1/L2 下 L3
// 标签总数。注意 TS 此查询**无 limit**（其余层级查询都有 500 上限）。
func kbCountL3sUnderL2(ctx context.Context, client *db.Client, userID, l1, l2 string) (int, error) {
	fetch := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null")
		})
	}
	notes, err := fetch(db.TableStudyNotes)
	if err != nil {
		return 0, err
	}
	materials, err := fetch(db.TableMaterials)
	if err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	for _, r := range append(append([]map[string]any{}, notes...), materials...) {
		tags, ok := r["tags"].([]any)
		if !ok || len(tags) < 3 {
			continue
		}
		if kbJSString(tags[0]) != l1 || kbJSString(tags[1]) != l2 {
			continue
		}
		for _, t := range tags[2:] {
			if s := kbJSString(t); s != "" {
				seen[s] = true
			}
		}
	}
	return len(seen), nil
}

// kbGetAllL3NamesUnderL2 复刻 getAllL3NamesUnderL2（:437-463）：
// L1/L2 下全部 L3 标签名（插入序去重，limit 500）。
func kbGetAllL3NamesUnderL2(ctx context.Context, client *db.Client, userID, l1, l2 string) ([]string, error) {
	fetch := func(table string) ([]map[string]any, error) {
		return kbSelectMaps(ctx, client, table, "tags", func(q *db.Query) *db.Query {
			return q.Eq("user_id", userID).Not("tags", "is", "null").Limit(500)
		})
	}
	notes, err := fetch(db.TableStudyNotes)
	if err != nil {
		return nil, err
	}
	materials, err := fetch(db.TableMaterials)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for _, r := range append(append([]map[string]any{}, notes...), materials...) {
		tags, ok := r["tags"].([]any)
		if !ok || len(tags) < 3 {
			continue
		}
		if kbJSString(tags[0]) != l1 || kbJSString(tags[1]) != l2 {
			continue
		}
		for _, t := range tags[2:] {
			if s := kbJSString(t); s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out, nil
}

// kbUpdateAIProcessResult 复刻 updateAiProcessResult（:782-800）：写回
// AI 分类结果；process_status 列由 migrations/004 添加，未执行迁移的库
// 返回 42703（或错误消息含列名）——去掉该列降级重试，保证主字段落库。
func kbUpdateAIProcessResult(ctx context.Context, client *db.Client, table string,
	payload map[string]any, id, userID string) error {
	_, err := client.From(table).Eq("id", id).Eq("user_id", userID).Update(ctx, payload)
	if err != nil {
		var pErr *db.PostgrestError
		isMissing := (errors.As(err, &pErr) && pErr.Code == "42703") ||
			strings.Contains(dbErrorMessage(err), "process_status")
		if isMissing {
			rest := make(map[string]any, len(payload))
			for k, v := range payload {
				rest[k] = v
			}
			delete(rest, "process_status")
			_, err = client.From(table).Eq("id", id).Eq("user_id", userID).Update(ctx, rest)
			log.Println("[process-content] process_status 列缺失，已降级写入" +
				"（在 Supabase SQL Editor 执行 migrations/004_add_process_status.sql 可恢复完整状态机）")
		}
	}
	return err
}

// kbSyncKnowledgeNode 复刻 syncKnowledgeNodeForMaterial（:801-840，
// issue #7 Task 5）：资料分类完成后同步 knowledge_nodes——按
// original_file 查既有节点则更新，否则插入影子节点。全程错误吞掉
// （TS try/catch 只 console.warn，主流程不受影响）。
func kbSyncKnowledgeNode(ctx context.Context, client *db.Client, userID string,
	material map[string]any, tags []string, papercore string) {
	sync := func() error {
		name, _ := material["name"].(string)
		shortName := kbJSSlice(kbJSOr(name, "资料"), 0, 50) // (material.name || '资料').slice(0, 50)
		existingRows, err := client.From(db.TableKnowledgeNodes).Select("id").
			Eq("user_id", userID).Eq("original_file", kbJSOr(name, "null")).Limit(1).Rows(ctx)
		if netErr := kbSwallowPostgrest(err); netErr != nil {
			return netErr
		}
		var existing []struct {
			ID int `json:"id"`
		}
		if jsonErr := json.Unmarshal(existingRows, &existing); jsonErr != nil {
			existing = nil
		}
		if len(existing) > 0 {
			_, err = client.From(db.TableKnowledgeNodes).Eq("id", fmt.Sprintf("%d", existing[0].ID)).
				Update(ctx, map[string]any{
					"papercore":  papercore,
					"short_name": shortName,
					"tags":       tags,
					"updated_at": jsNowISO(),
				})
			return kbSwallowPostgrest(err)
		}
		var origFile any // TS：original_file: material.name || null
		if name != "" {
			origFile = name
		}
		_, err = client.From(db.TableKnowledgeNodes).Insert(ctx, map[string]any{
			"user_id":            userID,
			"original_file":      origFile,
			"papercore":          papercore,
			"short_name":         shortName,
			"tags":               tags,
			"relations":          map[string]any{},
			"attached_draft_ids": []any{},
		})
		return kbSwallowPostgrest(err)
	}
	if err := sync(); err != nil {
		// TS 的 catch 只 warn 不上抛；网络错误在 Go 侧同样只记录
		log.Printf("[sync-knode] failed: %v", err)
	}
}

// kbJSOr 复刻 a || b（字符串版）。
func kbJSOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// kbFindMaterialFile 复刻 readMaterialFileFromDisk / reprocess-material
// 的文件定位（:843-862、1256-1282）：file_path|file_url 去 /uploads/ 前缀
// 拼 uploads 目录 → name 拼 test_data/学习资料 →（仅 reprocess）目录内
// 双向包含模糊匹配。返回空串表示未找到。
func kbFindMaterialFile(storedPath, name string, fuzzy bool) string {
	uploadsDir := config.Load().UploadDir
	cwd, _ := os.Getwd()
	testDataDir := filepath.Join(cwd, "..", "test_data", "学习资料") // TS：path.resolve(cwd, '..', 'test_data', '学习资料')

	if storedPath != "" {
		urlPath := regexp.MustCompile(`^/uploads/`).ReplaceAllString(storedPath, "")
		candidate := filepath.Join(uploadsDir, urlPath)
		if kbFileExists(candidate) {
			return candidate
		}
	}
	if name != "" {
		candidate := filepath.Join(testDataDir, name)
		if kbFileExists(candidate) {
			return candidate
		}
	}
	if fuzzy && name != "" {
		entries, err := os.ReadDir(testDataDir)
		if err != nil {
			return "" // TS 的 try {} catch {} 静默吞错
		}
		for _, e := range entries {
			f := e.Name()
			if strings.Contains(f, name) || strings.Contains(name, f) {
				return filepath.Join(testDataDir, f)
			}
		}
	}
	return ""
}

func kbFileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// kbReadMaterialFileFromDisk 复刻 readMaterialFileFromDisk（:842-884）：
// 定位文件后经 extracttext.ExtractText 提取（带两级缓存），任何失败
// 返回空串（TS 整体 try/catch → ”）。
func kbReadMaterialFileFromDisk(material map[string]any) (text string) {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[readMaterialFileFromDisk] Error: %v", e)
			text = ""
		}
	}()
	storedPath, _ := material["file_path"].(string)
	if storedPath == "" {
		storedPath, _ = material["file_url"].(string)
	}
	name, _ := material["name"].(string)
	filePath := kbFindMaterialFile(storedPath, name, false)
	if filePath == "" {
		return ""
	}
	ext := strings.ToLower(filepath.Ext(filePath))
	mimeMap := map[string]string{
		".pdf":  "application/pdf",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".md":   "text/markdown",
		".txt":  "text/plain",
		".csv":  "text/plain",
	}
	mimeType := mimeMap[ext]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	result, _ := extracttext.ExtractText(filePath, mimeType, filepath.Base(filePath))
	return result.Text // TS：result.text || ''
}

// ── 不可读扫描件的课程映射（issue #7 Task 6）───────────────────────

// kbUnreadableFileCourseMap 复刻 UNREADABLE_FILE_COURSE_MAP（:17-32）：
// 不可读扫描件（乱码/无文本）的文件名 → 课程映射；新增课程只需在此追加
// 条目，批处理分类与 L3 合并自动生效。
type kbCourseEntry struct {
	Pattern      *regexp.Regexp
	L1, L2       string
	CourseSystem string
	TopicHint    string
}

var kbUnreadableFileCourseMap = []kbCourseEntry{
	{
		Pattern: regexp.MustCompile(`(?i)^Bi_`),
		L1:      "数学",
		L2:      "运筹学",
		CourseSystem: "线性规划、单纯形法、对偶理论、灵敏度分析、运输问题、指派问题、" +
			"网络优化、动态规划、整数规划、博弈论、决策分析、排队论、库存论、非线性规划",
		TopicHint: "Bi_ORC{N} 中 N 对应课程模块，week{X} 对应教学周，据此推断话题",
	},
}

// kbCourseClassifyResult 是 classifyUnreadableByCourse 的返回
// （:36-93）：nil 对应 TS 的 null（未命中或 LLM 失败）。
type kbCourseClassifyResult struct {
	L1, L2 string
	L3s    []string
	Topic  string
}

// kbClassifyUnreadableByCourse 复刻 classifyUnreadableByCourse（:36-93）：
// 文件名命中课程映射时，结合已有 L3 让 LLM 推断真实话题（而非复述文件名
// 的降级模板）；LLM 失败/解析无效返回 nil，绝不抛错。
func kbClassifyUnreadableByCourse(ctx context.Context, client *db.Client, userID, fileName string) *kbCourseClassifyResult {
	var course *kbCourseEntry
	for i := range kbUnreadableFileCourseMap {
		if kbUnreadableFileCourseMap[i].Pattern.MatchString(kbJSOr(fileName, "")) {
			course = &kbUnreadableFileCourseMap[i]
			break
		}
	}
	if course == nil {
		return nil
	}
	result := func() *kbCourseClassifyResult {
		existingL3s, err := kbGetAllL3NamesUnderL2(ctx, client, userID, course.L1, course.L2)
		if err != nil {
			log.Printf("[course-classify] error: %v", err) // TS catch：console.error 后返回 null
			return nil
		}
		existingText := strings.Join(existingL3s, ", ")
		if existingText == "" {
			existingText = "(尚无)"
		}
		prompt := fmt.Sprintf(`你是%s课程专家。以下是一个%s课程PDF的文件名，由于PDF编码问题无法提取文本，请根据文件名推断核心话题。

文件名：%s

%s下已有L3标签：%s

标准课程体系参考：%s。

规则：
1. %s
2. L3标签必须使用标准课程体系中的大类名称（如"对偶理论"而非细碎定理），优先复用已有标签
3. 最多3个L3标签

输出JSON（不要markdown代码块）：{"topic":"简要话题描述（50字以内）","l3s":["大类标签1"]}`,
			course.L2, course.L2, fileName, course.L2, existingText, course.CourseSystem, course.TopicHint)
		// thinking 型模型的思考块会消耗输出预算：无正文时升档重试（同全局定位的修复）
		var c string
		for _, budget := range []int{8192, 32768} {
			content, err := kbLLMText(ctx, prompt, budget, 0.3)
			if err != nil {
				log.Printf("[course-classify] error: %v", err)
				return nil
			}
			c = content
			if c != "" {
				break
			}
			log.Printf("[course-classify] 无正文输出（预算 %d），升档重试", budget)
		}
		log.Printf("[course-classify] LLM 响应: %s", kbJSSlice(c, 0, 120))
		m, ok := pslExtractJSONObject(c)
		if !ok {
			log.Println("[course-classify] 响应无 JSON 对象")
			return nil
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(m), &parsed); err != nil {
			log.Printf("[course-classify] error: %v", err)
			return nil
		}
		var l3s []string
		if arr, ok := parsed["l3s"].([]any); ok {
			for i, t := range arr {
				if i >= 3 {
					break // slice(0, 3)
				}
				s, isStr := t.(string)
				if !isStr || kbJSTrim(s) == "" {
					continue // filter(t => typeof t === 'string' && t.trim())
				}
				l3s = append(l3s, s)
			}
		}
		topicStr := ""
		if jsTruthy(parsed["topic"]) {
			topicStr = kbJSSlice(kbJSString(parsed["topic"]), 0, 80) // String(parsed.topic).slice(0, 80)
		}
		if len(l3s) > 0 && topicStr != "" {
			return &kbCourseClassifyResult{
				L1: course.L1, L2: course.L2, L3s: l3s, Topic: topicStr,
			}
		}
		log.Printf("[course-classify] 解析结果无效: l3s=%v topic=%v", l3s, parsed["topic"])
		return nil
	}()
	return result
}
