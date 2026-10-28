package retrieval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// 契约来源：server/src/utils/unified-vector-index.ts。

// SourceType 对应 unified-vector-index.ts:18 的四种内容源。
type SourceType string

const (
	SourceKnowledgeNode SourceType = "knowledge_node"
	SourceStudyNote     SourceType = "study_note"
	SourceMaterial      SourceType = "material"
	SourceFileContent   SourceType = "file_content"
)

// UnifiedSearchResult 对应 unified-vector-index.ts:17-28。
// TS 中 pageNumber/draftId/fileName 为可选字段；Go 用零值表示未填，
// 序列化 JSON 时按需用 omitempty 包装（当前索引源仅 study_note/material，
// 三个可选字段恒为零值——见 TS:79-146 的设计演进注释）。
type UnifiedSearchResult struct {
	SourceType SourceType `json:"sourceType"`
	// SourceID：TS 类型为 number | string（study_note/material 为数字 id）。
	SourceID  any      `json:"sourceId"`
	Title     string   `json:"title"`
	Papercore string   `json:"papercore"`
	Tags      []string `json:"tags"`
	// RawScore 为余弦相似度原始分；Score 为标签加成后的最终分。
	RawScore float64 `json:"rawScore"`
	Score    float64 `json:"score"`
}

// tagBoostFactor 是标签匹配能带来的最大分数加成（unified-vector-index.ts:44）。
const tagBoostFactor = 0.3

// indexRecord 对应 unified-vector-index.ts:30-40 的 IndexRecord。
// pageNumber/draftId/fileName 在当前索引源下恒为空（TS:79-146 的设计演进），
// 故不设字段；未来重新接入 file_content 时需与 TS 同步补列。
type indexRecord struct {
	sourceType SourceType
	sourceID   int
	title      string
	papercore  string
	tags       []string
	vec        []float64
}

// scoredItem 是检索过程中的打分中间态（unified-vector-index.ts:211-218）。
type scoredItem struct {
	rec      *indexRecord
	rawScore float64
	score    float64
}

// UnifiedVectorIndex 对应 unified-vector-index.ts:48-293 的同名类。
// 单例见 Unified()（对应 `export const unifiedVectorIndex`，:296）。
//
// 索引范围（TS:79-146 的设计现状，移植时勿扩大）：
//   - knowledge_nodes 已退出检索（避免与资料重复的引用卡）
//   - 只索引 study_notes + materials 中 ai_processed=true 且 papercore 非空的行
//   - file_contents 不进文档层（Stage 2 由 passage-locator 负责）
//   - 文档层嵌入文本 = papercore + "\n" + tags.join(" ")
type UnifiedVectorIndex struct {
	mu        sync.RWMutex // 保护以下全部字段
	building  bool
	buildDone chan struct{} // 正在进行的构建的完成信号（TS 的 buildPromise 去重）
	buildErr  error         // 最近一次构建结果，供并发等待方复用
	records   []indexRecord
	ready     bool
}

var unifiedVectorIndex = &UnifiedVectorIndex{}

// Unified 返回全局单例（对应 TS 的 unifiedVectorIndex 导出）。
func Unified() *UnifiedVectorIndex { return unifiedVectorIndex }

// IsReady 对应 TS:54-56。
func (i *UnifiedVectorIndex) IsReady() bool {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.ready
}

// RecordCount 对应 getRecordCount（TS:58-60）。
func (i *UnifiedVectorIndex) RecordCount() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return len(i.records)
}

// BuildIndex 全量（重）建索引（TS:66-179）。正在构建时复用同一构建承诺
// （TS 的 buildPromise 去重）：并发调用等待同一构建并拿到同一结果。
// 构建失败时 TS 吞错只打日志；Go 返回 error 由调用方决定
// （WarmStartIndex 会像 TS 一样只 warn 不中断）。
func (i *UnifiedVectorIndex) BuildIndex(ctx context.Context) error {
	i.mu.Lock()
	if i.building {
		done := i.buildDone
		i.mu.Unlock()
		<-done
		i.mu.Lock()
		err := i.buildErr
		i.mu.Unlock()
		return err
	}
	i.building = true
	i.ready = false
	done := make(chan struct{})
	i.buildDone = done
	i.mu.Unlock()

	err := i.doBuild(ctx)

	i.mu.Lock()
	i.buildErr = err
	i.building = false
	i.mu.Unlock()
	close(done)
	if err != nil {
		log.Printf("[UnifiedVectorIndex] Build failed: %v", err)
	}
	return err
}

// studyNoteIndexRow / materialIndexRow 对应 buildIndex 的两段 select 列
// （unified-vector-index.ts:88 / :118）。
type studyNoteIndexRow struct {
	ID        int      `json:"id"`
	Papercore *string  `json:"papercore"`
	Tags      []string `json:"tags"`
	Title     *string  `json:"title"`
}

type materialIndexRow struct {
	ID        int      `json:"id"`
	Papercore *string  `json:"papercore"`
	Tags      []string `json:"tags"`
	Name      *string  `json:"name"`
}

// loadIndexRows 拉取单表索引行：ai_processed=true、papercore 非空、
// created_at 降序（TS:86-91 / :116-121）。PostgREST 错误按 TS 的
// error 字段处理（打日志跳过该表），网络类异常原样上抛（TS 外层 catch）。
func loadIndexRows[T any](ctx context.Context, client *db.Client, table, cols string, out *[]T) error {
	raw, err := client.From(table).Select(cols).
		Eq("ai_processed", "true").
		Not("papercore", "is", "null").
		Order("created_at", false).
		Rows(ctx)
	if err != nil {
		var pe *db.PostgrestError
		if errors.As(err, &pe) {
			log.Printf("[UnifiedVectorIndex] %s fetch error: %v", table, err)
			return nil
		}
		return err
	}
	return json.Unmarshal(raw, out)
}

func (i *UnifiedVectorIndex) doBuild(ctx context.Context) error {
	client, err := db.Get()
	if err != nil {
		return err
	}
	var records []indexRecord

	// ── 1. knowledge_nodes 已退出检索（TS:79-82：分类管线同步的影子节点
	//    会与资料产生重复的「知识节点」引用卡，检索层同样跳过）──

	// ── 2. Load study_notes (ai_processed=true, papercore non-empty) ─
	log.Println("[UnifiedVectorIndex] Loading study_notes...")
	var snRows []studyNoteIndexRow
	if err := loadIndexRows(ctx, client, db.TableStudyNotes, "id, papercore, tags, title", &snRows); err != nil {
		return err
	}
	for _, row := range snRows {
		papercore := ""
		if row.Papercore != nil {
			papercore = *row.Papercore
		}
		if trimJS(papercore) == "" { // TS：if (papercore.trim())
			continue
		}
		title := ""
		if row.Title != nil {
			title = *row.Title
		}
		if title == "" {
			title = fmt.Sprintf("学习纪要%d", row.ID)
		}
		records = append(records, indexRecord{
			sourceType: SourceStudyNote,
			sourceID:   row.ID,
			title:      title,
			papercore:  papercore,
			tags:       tagsOrEmpty(row.Tags),
		})
	}
	log.Printf("[UnifiedVectorIndex]   → %d study_notes", countByType(records, SourceStudyNote))

	// ── 3. Load materials (ai_processed=true, papercore non-empty) ─
	log.Println("[UnifiedVectorIndex] Loading materials...")
	var mRows []materialIndexRow
	if err := loadIndexRows(ctx, client, db.TableMaterials, "id, papercore, tags, name", &mRows); err != nil {
		return err
	}
	for _, row := range mRows {
		papercore := ""
		if row.Papercore != nil {
			papercore = *row.Papercore
		}
		if trimJS(papercore) == "" {
			continue
		}
		title := ""
		if row.Name != nil {
			title = *row.Name
		}
		if title == "" {
			title = fmt.Sprintf("资料%d", row.ID)
		}
		records = append(records, indexRecord{
			sourceType: SourceMaterial,
			sourceID:   row.ID,
			title:      title,
			papercore:  papercore,
			tags:       tagsOrEmpty(row.Tags),
		})
	}
	log.Printf("[UnifiedVectorIndex]   → %d materials", countByType(records, SourceMaterial))

	// ── 4. file_contents 退出统一索引（TS:144-146）：Stage 1 只做文档层
	//    （tags+papercore），Stage 2 由 passage-locator 对命中文件的全文
	//    做文段级检索 ──

	if len(records) == 0 {
		i.mu.Lock()
		i.records = nil
		i.ready = true
		i.mu.Unlock()
		log.Println("[UnifiedVectorIndex] No records found, index empty.")
		return nil
	}

	// ── 5. Embed docs: papercore + L1/L2/L3 标签名（TS:155-164）────
	//    文档层嵌入 = 摘要 + 全部标签名（分类信号直接参与语义匹配）；
	//    正文不再进文档层——文段级检索由 passage-locator（Stage 2）负责
	log.Printf("[UnifiedVectorIndex] Embedding %d records...", len(records))
	texts := make([]string, len(records))
	for idx := range records {
		texts[idx] = records[idx].papercore + "\n" + strings.Join(records[idx].tags, " ")
	}
	vectors, err := embedMany(texts)
	if err != nil {
		return err
	}
	for idx := range records {
		records[idx].vec = vectors[idx]
	}

	i.mu.Lock()
	i.records = records
	i.ready = true
	i.mu.Unlock()
	log.Printf("[UnifiedVectorIndex] Index built: %d records (kn:%d sn:%d m:%d fc:%d)",
		len(records),
		countByType(records, SourceKnowledgeNode),
		countByType(records, SourceStudyNote),
		countByType(records, SourceMaterial),
		countByType(records, SourceFileContent))
	return nil
}

// Search 语义检索 + 标签重排（TS:189-292），默认 topK=10 / minScore=0.3：
//  1. 索引未就绪时先尝试 BuildIndex；TS 的 buildPromise 不会 reject，
//     构建失败后继续用旧 records 检索（Go 同此语义，不返回该错误）
//  2. 查询向量与全部记录算余弦
//  3. 标签重排：语义（searchL1 阈值 0.25 / searchL2 阈值 0.2）+ 字面子串
//     双路命中；层级加权 L1 +0.02 / L2 +0.05 / L3 +0.1，总加成上限 0.3
//     （TAG_BOOST_FACTOR，TS:44）
//  4. score >= minScore 过滤、降序（稳定排序）、截 topK
//
// 仅查询嵌入失败时返回错误（TS 侧 catch 后返回空数组，Go 按 PORTING.md
// 约定把 error 交给 handler 决定降级）。
func (i *UnifiedVectorIndex) Search(
	ctx context.Context, query string, topK int, minScore float64,
) ([]UnifiedSearchResult, error) {
	if !i.IsReady() {
		log.Println("[UnifiedVectorIndex] Index not ready, attempting build...")
		_ = i.BuildIndex(ctx) // TS：构建失败被吞，继续用旧 records（可能为空）
	}

	i.mu.RLock()
	records := make([]indexRecord, len(i.records))
	copy(records, i.records)
	i.mu.RUnlock()
	if len(records) == 0 {
		return []UnifiedSearchResult{}, nil
	}

	queryVec, err := embedOne(query)
	if err != nil {
		log.Printf("[UnifiedVectorIndex] Search failed: %v", err)
		return nil, err
	}

	// ── Step 1: Raw cosine similarity scoring ─────────────────────
	scored := make([]scoredItem, len(records))
	for idx := range records {
		raw := CosineSimilarity(queryVec, records[idx].vec)
		scored[idx] = scoredItem{rec: &records[idx], rawScore: raw, score: raw}
	}

	// ── Step 2: Tag-based re-ranking ──────────────────────────────
	queryTags, boostedCount := applyTagBoost(TagStore(), query, queryVec, scored)
	if boostedCount > 0 {
		log.Printf("[UnifiedVectorIndex] Tag-boosted %d/%d records (query tags: %s)",
			boostedCount, len(scored), strings.Join(queryTags, ", "))
	}

	// ── Step 3: Filter by minScore, sort, top-K ───────────────────
	passed := make([]*scoredItem, 0, len(scored))
	for idx := range scored {
		if scored[idx].score >= minScore {
			passed = append(passed, &scored[idx])
		}
	}
	sort.SliceStable(passed, func(a, b int) bool { return passed[a].score > passed[b].score })
	if topK >= 0 && len(passed) > topK {
		passed = passed[:topK]
	}

	results := make([]UnifiedSearchResult, 0, len(passed))
	for _, item := range passed {
		results = append(results, UnifiedSearchResult{
			SourceType: item.rec.sourceType,
			SourceID:   item.rec.sourceID,
			Title:      item.rec.title,
			Papercore:  item.rec.papercore,
			Tags:       item.rec.tags,
			RawScore:   item.rawScore,
			Score:      item.score,
		})
	}
	return results, nil
}

// applyTagBoost 实现 Step 2 的标签重排（unified-vector-index.ts:220-264）：
// 语义双路（searchL1 top3 阈 0.25 / searchL2 top5 阈 0.2）+ 字面子串命中
// 合成 queryTags；记录标签按下标加权：idx0（L1 学科）+0.02、idx1（L2 领域）
// +0.05、idx2+（L3 章节/概念）+0.1，总加成封顶 tagBoostFactor。
// 返回（按命中顺序的 queryTags —— 与 JS Set 迭代序一致，供日志与断言），
// 以及被提升的记录数。
func applyTagBoost(store *TagVectorStore, query string, queryVec []float64, scored []scoredItem) ([]string, int) {
	if store == nil || !store.IsReady() || store.Count() == 0 {
		return nil, 0
	}

	// Approach A: semantic tag matching（低阈值）
	queryTags := newOrderedSet()
	for _, hit := range store.SearchL1(queryVec, 3, 0.25) {
		queryTags.add(hit.Name)
	}
	for _, hit := range store.SearchL2(queryVec, 5, 0.2) {
		queryTags.add(hit.Name)
	}
	// Approach B: 字面词级匹配——查询里包含标签名即视为命中
	for _, tag := range store.GetAllTags() {
		if strings.Contains(query, tag) {
			queryTags.add(tag)
		}
	}
	if queryTags.length() == 0 {
		return nil, 0
	}

	boosted := 0
	for idx := range scored {
		item := &scored[idx]
		recordTags := item.rec.tags
		if len(recordTags) == 0 {
			continue
		}
		// 层级加权：L1 学科（数学/计算机科学）几乎覆盖全部资料，平权加分
		// 等于无差别抬分把无关资料抬过阈值——L3 匹配权重最高（TS:245-251）
		boost := 0.0
		for ti, t := range recordTags {
			if !queryTags.has(t) {
				continue
			}
			switch ti {
			case 0:
				boost += 0.02
			case 1:
				boost += 0.05
			default:
				boost += 0.1
			}
		}
		if boost > 0 {
			item.score = item.rawScore * (1 + math.Min(boost, tagBoostFactor))
			boosted++
		}
	}
	return queryTags.slice(), boosted
}

// orderedSet 复刻 JS Set 的插入序语义（queryTags 的迭代顺序会进日志）。
type orderedSet struct {
	seen map[string]struct{}
	vals []string
}

func newOrderedSet() *orderedSet { return &orderedSet{seen: make(map[string]struct{})} }

func (s *orderedSet) add(v string) {
	if _, ok := s.seen[v]; ok {
		return
	}
	s.seen[v] = struct{}{}
	s.vals = append(s.vals, v)
}

func (s *orderedSet) has(v string) bool {
	_, ok := s.seen[v]
	return ok
}

func (s *orderedSet) length() int { return len(s.vals) }

func (s *orderedSet) slice() []string { return append([]string(nil), s.vals...) }

func countByType(records []indexRecord, t SourceType) int {
	n := 0
	for _, r := range records {
		if r.sourceType == t {
			n++
		}
	}
	return n
}

// tagsOrEmpty 对应 TS 的 `row.tags || []`：保证记录与结果里的 tags
// 恒为非 nil 切片（JSON 序列化为 [] 而非 null，与 TS 一致）。
func tagsOrEmpty(tags []string) []string {
	if tags != nil {
		return tags
	}
	return []string{}
}
