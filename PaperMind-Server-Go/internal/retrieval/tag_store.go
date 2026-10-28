package retrieval

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// 契约来源：server/src/utils/vector-store.ts。
// TS 跑在事件循环单线程上；Go 侧全部读写都在 mu 保护下进行，
// 构建期间检索可并发读到旧标签集（TS 语义：构建中途读到半旧状态）。

// TagLevel 对应 vector-store.ts:6 的 'L1' | 'L2' | 'L3'。
type TagLevel string

const (
	TagL1 TagLevel = "L1" // 学科（数学/计算机科学）
	TagL2 TagLevel = "L2" // 领域
	TagL3 TagLevel = "L3" // 章节/概念
)

// TagEntry 对应 vector-store.ts:4-10 的 TagEntry。
type TagEntry struct {
	ID       string // "<level>_<name>"，如 "L1_数学"
	Name     string
	Level    TagLevel
	ParentID string // 层级父标签（TS 中可选且当前未参与逻辑）
	Vec      []float64
}

// TagInput 对应 addTags 的入参（vector-store.ts:121）。
type TagInput struct {
	Name  string
	Level TagLevel
}

// TagHit 对应 searchL1/L2/L3 的返回项（vector-store.ts:141-143）。
type TagHit struct {
	Name  string
	Score float64
}

// TagHierarchy 对应 buildFromHierarchy 的入参（vector-store.ts:23）。
type TagHierarchy struct {
	L1 []string
	L2 []string
	L3 []string
}

// TagVectorStore 对应 vector-store.ts:16-188 的 class TagVectorStore。
// 单例见 TagStore()（对应 `export const tagVectorStore`，vector-store.ts:191）。
type TagVectorStore struct {
	mu          sync.RWMutex
	tags        []TagEntry
	initialized bool
}

var tagVectorStore = &TagVectorStore{}

// TagStore 返回全局单例（对应 TS 的 tagVectorStore 导出）。
func TagStore() *TagVectorStore { return tagVectorStore }

// tagRow 是三表拉取 tags 列时的行形状（vector-store.ts:77-79）。
type tagRow struct {
	Tags []string `json:"tags"`
}

// tagSet 复刻 TS Map 的“插入序 + 去重”语义（vector-store.ts:57-72 的 allTags）。
type tagSet struct {
	levels map[string]TagLevel
	order  []string
}

func newTagSet() *tagSet { return &tagSet{levels: make(map[string]TagLevel)} }

func (s *tagSet) addIfAbsent(key string, level TagLevel) {
	if _, ok := s.levels[key]; ok {
		return
	}
	s.levels[key] = level
	s.order = append(s.order, key)
}

// collectTagsInto 对应 vector-store.ts:60-72 的 collectTags 闭包：
// 层级按数组位置推断（index 0 = L1，1 = L2，2+ = L3），
// 键 = "<level>_<trim 后的名字>"，名字 trim 后为空则跳过。
func collectTagsInto(set *tagSet, tagsArray []string) {
	for i, raw := range tagsArray {
		name := trimJS(raw)
		if name == "" {
			continue
		}
		var level TagLevel
		switch i {
		case 0:
			level = TagL1
		case 1:
			level = TagL2
		default:
			level = TagL3
		}
		set.addIfAbsent(string(level)+"_"+name, level)
	}
}

// BuildFromHierarchy 从既有标签层级构建（vector-store.ts:23-47）：
// 三层合并成一次 embedBatch 批量请求（避免逐条 HTTP 往返）。
// 注意：embed 失败时错误上抛且 initialized 保持原值——TS 版没有 try/catch，
// 这一点与 BuildFromDatabase（失败时回落 initialized=false）不同。
func (s *TagVectorStore) BuildFromHierarchy(ctx context.Context, hierarchy TagHierarchy) error {
	pending := make([]TagInput, 0, len(hierarchy.L1)+len(hierarchy.L2)+len(hierarchy.L3))
	for _, level := range []TagLevel{TagL1, TagL2, TagL3} {
		var names []string
		switch level {
		case TagL1:
			names = hierarchy.L1
		case TagL2:
			names = hierarchy.L2
		default:
			names = hierarchy.L3
		}
		for _, name := range names {
			if name == "" {
				continue // TS：if (!name) continue（不做 trim）
			}
			pending = append(pending, TagInput{Name: name, Level: level})
		}
	}

	s.mu.Lock()
	s.tags = nil
	s.mu.Unlock()

	if len(pending) > 0 {
		names := make([]string, len(pending))
		for i, p := range pending {
			names[i] = p.Name
		}
		vecs, err := embedMany(names)
		if err != nil {
			return err
		}
		tags := make([]TagEntry, len(pending))
		for i, p := range pending {
			tags[i] = TagEntry{
				ID:    string(p.Level) + "_" + p.Name,
				Name:  p.Name,
				Level: p.Level,
				Vec:   vecs[i],
			}
		}
		s.mu.Lock()
		s.tags = tags
		s.mu.Unlock()
	}

	s.mu.Lock()
	s.initialized = true
	count := len(s.tags)
	s.mu.Unlock()
	// 日志里 L1/L2/L3 计数用层级数组的原始长度（含被跳过的空名），与 TS 一致
	log.Printf("[vector-store] Indexed %d tags (L1:%d, L2:%d, L3:%d)",
		count, len(hierarchy.L1), len(hierarchy.L2), len(hierarchy.L3))
	return nil
}

// BuildFromDatabase 从 knowledge_nodes / study_notes / materials 三表
// 收集去重标签并嵌入（vector-store.ts:53-120）。层级按数组位置推断：
// index 0 = L1，1 = L2，2+ = L3。表访问走 internal/db。
//
// 错误语义（对齐 TS）：
//   - 缺 Supabase 凭据：getSupabaseClient 在 try 之外，错误直接上抛；
//   - 单表 PostgREST 错误：supabase-js 放进 error 字段而不抛出，TS 不检查
//     该字段——等价于静默跳过这张表；
//   - 网络类异常 / 嵌入失败：TS 进 catch 打日志并置 initialized=false，
//     Go 同样打日志、保持 initialized=false，并把错误返回给调用方。
func (s *TagVectorStore) BuildFromDatabase(ctx context.Context) error {
	s.mu.Lock()
	s.tags = nil
	s.initialized = false
	s.mu.Unlock()

	client, err := db.Get()
	if err != nil {
		return err
	}

	// 三表并发拉取（TS Promise.all，vector-store.ts:76-80）。结果按
	// knowledge_nodes → study_notes → materials 的固定顺序合并，
	// 保持与 TS 顺序处理等价的标签插入序（影响同分候选的稳定排序）。
	tables := []string{db.TableKnowledgeNodes, db.TableStudyNotes, db.TableMaterials}
	perTable := make([]*tagSet, len(tables))
	fetchErrs := make([]error, len(tables))
	var wg sync.WaitGroup
	for i, table := range tables {
		wg.Add(1)
		go func(i int, table string) {
			defer wg.Done()
			set := newTagSet()
			perTable[i] = set
			raw, qerr := client.From(table).Select("tags").
				Not("tags", "is", "null").Limit(5000).Rows(ctx)
			if qerr != nil {
				var pe *db.PostgrestError
				if errors.As(qerr, &pe) {
					return // PostgREST 错误：静默跳过该表（同 TS 不检查 error 字段）
				}
				fetchErrs[i] = qerr // 网络类异常：TS 会进 catch
				return
			}
			var rows []tagRow
			if uerr := json.Unmarshal(raw, &rows); uerr != nil {
				fetchErrs[i] = uerr
				return
			}
			for _, row := range rows {
				collectTagsInto(set, row.Tags)
			}
		}(i, table)
	}
	wg.Wait()

	for _, ferr := range fetchErrs {
		if ferr != nil {
			log.Printf("[vector-store] buildFromDatabase failed: %v", ferr)
			return ferr // initialized 已在开头置 false（对应 TS catch 分支）
		}
	}

	merged := newTagSet()
	for _, set := range perTable {
		if set == nil {
			continue
		}
		for _, key := range set.order {
			merged.addIfAbsent(key, set.levels[key])
		}
	}
	log.Printf("[vector-store] Collected %d unique tags from DB", len(merged.order))

	if len(merged.order) == 0 {
		s.mu.Lock()
		s.initialized = true
		s.mu.Unlock()
		return nil
	}

	// 对等移植 TS 现状（vector-store.ts:94-96）：names 取的是 Map 的 value，
	// 即 'L1'/'L2'/'L3' 字符串本身，而非标签名——所有同层级标签因此共享同一
	// 向量，语义标签检索退化为“层级同分 + 字面匹配”。这是按 TS 原样保留的
	// 行为（非移植笔误）；如需修正必须 TS/Go 两端同步，否则标签加成分叉。
	names := make([]string, len(merged.order))
	for i, key := range merged.order {
		names[i] = string(merged.levels[key])
	}
	vecs, err := embedMany(names)
	if err != nil {
		log.Printf("[vector-store] buildFromDatabase failed: %v", err)
		return err
	}
	tags := make([]TagEntry, len(merged.order))
	for i, key := range merged.order {
		tags[i] = TagEntry{
			ID:    key,
			Name:  key[3:], // 剥掉 "L1_"/"L2_"/"L3_" 前缀（ASCII，字节切片安全）
			Level: merged.levels[key],
			Vec:   vecs[i],
		}
	}

	var l1, l2, l3 int
	for _, tag := range tags {
		switch tag.Level {
		case TagL1:
			l1++
		case TagL2:
			l2++
		default:
			l3++
		}
	}
	s.mu.Lock()
	s.tags = tags
	s.initialized = true
	s.mu.Unlock()
	log.Printf("[vector-store] Indexed %d tags from DB (L1:%d, L2:%d, L3:%d)", len(tags), l1, l2, l3)
	return nil
}

// AddTags 追加新标签（vector-store.ts:121-136），空名与已存在
// （同 level+name）的跳过；嵌入失败时错误上抛、状态不变。
func (s *TagVectorStore) AddTags(ctx context.Context, tags []TagInput) error {
	s.mu.Lock()
	existing := make(map[string]bool, len(s.tags))
	for _, t := range s.tags {
		existing[t.ID] = true
	}
	fresh := make([]TagInput, 0, len(tags))
	for _, tag := range tags {
		if tag.Name == "" { // TS filter(tag.name) 真值判断
			continue
		}
		id := string(tag.Level) + "_" + tag.Name
		if existing[id] {
			continue
		}
		existing[id] = true // 同批内的重复也只取第一个
		fresh = append(fresh, tag)
	}
	s.mu.Unlock()

	if len(fresh) == 0 {
		return nil
	}
	names := make([]string, len(fresh))
	for i, tag := range fresh {
		names[i] = tag.Name
	}
	vecs, err := embedMany(names)
	if err != nil {
		return err
	}

	s.mu.Lock()
	// 复检：嵌入期间并发 AddTags 可能已落同名标签（TS 单线程无此竞争，
	// Go 在并发下仍须维持“无重复 id”的不变量）
	for i, tag := range fresh {
		id := string(tag.Level) + "_" + tag.Name
		dup := false
		for _, t := range s.tags {
			if t.ID == id {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		s.tags = append(s.tags, TagEntry{
			ID:    id,
			Name:  tag.Name,
			Level: tag.Level,
			Vec:   vecs[i],
		})
	}
	s.mu.Unlock()
	return nil
}

// SearchL1 在 L1 标签里找最相似 topK（vector-store.ts:141-147，默认 topK=3 / 阈值 0.4）。
func (s *TagVectorStore) SearchL1(docVec []float64, topK int, minScore float64) []TagHit {
	return s.searchLevel(TagL1, docVec, topK, minScore)
}

// SearchL2 在 L2 标签里找最相似 topK（vector-store.ts:152-158，默认 topK=5 / 阈值 0.4）。
func (s *TagVectorStore) SearchL2(docVec []float64, topK int, minScore float64) []TagHit {
	return s.searchLevel(TagL2, docVec, topK, minScore)
}

// SearchL3 在 L3 标签里找最相似 topK（vector-store.ts:163-169，默认 topK=10 / 阈值 0.4）。
func (s *TagVectorStore) SearchL3(docVec []float64, topK int, minScore float64) []TagHit {
	return s.searchLevel(TagL3, docVec, topK, minScore)
}

func (s *TagVectorStore) searchLevel(level TagLevel, docVec []float64, topK int, minScore float64) []TagHit {
	s.mu.RLock()
	candidates := make([]Candidate, 0, len(s.tags))
	for _, t := range s.tags {
		if t.Level != level {
			continue
		}
		candidates = append(candidates, Candidate{ID: t.ID, Name: t.Name, Vec: t.Vec})
	}
	s.mu.RUnlock()

	hits := FindTopK(docVec, candidates, topK, minScore)
	out := make([]TagHit, 0, len(hits))
	for _, h := range hits {
		out = append(out, TagHit{Name: h.Name, Score: h.Score})
	}
	return out
}

// GetAllTags 返回全部标签名（扁平字符串数组，供字面匹配，vector-store.ts:174-176）。
func (s *TagVectorStore) GetAllTags() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, len(s.tags))
	for i, t := range s.tags {
		out[i] = t.Name
	}
	return out
}

// Count 对应 get count（vector-store.ts:181-183）。
func (s *TagVectorStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.tags)
}

// IsReady 对应 get isReady（vector-store.ts:185-187）。
func (s *TagVectorStore) IsReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.initialized
}
