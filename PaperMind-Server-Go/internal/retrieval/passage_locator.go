package retrieval

import (
	"context"
	"strconv"
	"strings"
	"sync"
)

// 契约来源：server/src/utils/passage-locator.ts（两阶段检索的 Stage 2）。

const (
	chunkSize        = 500 // 块字符数（passage-locator.ts:13）
	maxChunksPerFile = 300 // 超大文件截断（150K 字覆盖，:14）
	minPassageScore  = 0.2 // 低于阈值视为未定位到文段（:15）
	cacheMaxFiles    = 20  // 惰性缓存文件数上限（LRU，:16）
)

// PassageHit 对应 passage-locator.ts:18-22。
type PassageHit struct {
	PageNumber int     `json:"pageNumber"`
	Text       string  `json:"text"` // 命中块文字
	Score      float64 `json:"score"`
}

type passageChunk struct {
	page int
	text string
}

// passageIndex 对应 passage-locator.ts:24-28。
type passageIndex struct {
	pages  []string
	chunks []passageChunk
	vecs   [][]float64
}

// passageCacheEntry 缓存“构建中/已构建”的索引，done 对应 TS 缓存的
// Promise——并发命中同一文件时后来者等待首次构建，不重复嵌入。
type passageCacheEntry struct {
	done chan struct{}
	idx  *passageIndex
}

var (
	passageMu    sync.Mutex
	passageCache = map[string]*passageCacheEntry{}
	passageOrder []string
)

// touchLocked 把键移到 LRU 尾部并从头淘汰超限项；调用方须持有 passageMu。
// 对应 passage-locator.ts:33-41 的 touch。
func touchLocked(key string) {
	for i, k := range passageOrder {
		if k == key {
			passageOrder = append(passageOrder[:i], passageOrder[i+1:]...)
			break
		}
	}
	passageOrder = append(passageOrder, key)
	for len(passageOrder) > cacheMaxFiles {
		evict := passageOrder[0]
		passageOrder = passageOrder[1:]
		delete(passageCache, evict)
	}
}

// chunkPages 按 \f 分页（空白页丢弃，页码按过滤后的顺序编号——与 TS 一致）
// 并对超长页做 ~500 字分块（passage-locator.ts:43-78）。
// 长度单位是 UTF-16 码元（JS 的 s.length），中文正文下等价于 rune 计数，
// 故实现统一走 []rune；断点优先换行（markdown 行边界），其次句末标点，
// 都找不到才在目标长度硬切，避免把词句拦腰截断。
func chunkPages(text string) (pages []string, chunks []passageChunk) {
	for _, raw := range strings.Split(text, "\f") {
		p := trimJS(raw)
		if p != "" {
			pages = append(pages, p)
		}
	}
	for pi, page := range pages {
		pr := []rune(page)
		// 整页不超过一块：长度 ≥ 20 才入块（TS:51-53，短页不受 300 上限约束）
		if len(pr) <= chunkSize {
			if len(pr) >= 20 {
				chunks = append(chunks, passageChunk{page: pi + 1, text: page})
			}
			continue
		}
		s := 0
		for s < len(pr) && len(chunks) < maxChunksPerFile {
			lo := s + (chunkSize*8)/10 // floor(s + CHUNK_SIZE*0.8) = s+400
			hi := s + chunkSize
			cut := -1
			scanHi := hi
			if scanHi > len(pr)-1 {
				scanHi = len(pr) - 1 // JS 里越界下标取 undefined 不命中，等价于不扫
			}
			for i := scanHi; i >= lo; i-- {
				if pr[i] == '\n' {
					cut = i + 1
					break
				}
			}
			if cut < 0 {
				for i := scanHi; i >= lo; i-- {
					if isSentenceEnd(pr[i]) {
						cut = i + 1
						break
					}
				}
			}
			if cut < 0 {
				cut = hi
			}
			end := cut
			if end > len(pr) {
				end = len(pr) // JS slice 自动收敛到串尾
			}
			piece := trimJS(stripLeadingBreaks(string(pr[s:end])))
			if len([]rune(piece)) >= 20 {
				chunks = append(chunks, passageChunk{page: pi + 1, text: piece})
			}
			s = cut
		}
	}
	return pages, chunks
}

// isSentenceEnd 对应断点标点集合 '。' '！' '？' '；' '．'（passage-locator.ts:68）。
func isSentenceEnd(r rune) bool {
	switch r {
	case '。', '！', '？', '；', '．':
		return true
	}
	return false
}

// stripLeadingBreaks 复刻 `.replace(/^[\s、，,。；;：:．]+/, ”)`
// （passage-locator.ts:72）：去掉块首的空白与顿号/逗号/句读，避免片段
// 从表格或列表分隔符中间开始。
func stripLeadingBreaks(s string) string {
	return strings.TrimLeftFunc(s, func(r rune) bool {
		return isJSWhitespace(r) || strings.ContainsRune("、，,。；;：:．", r)
	})
}

// bigramScore 是嵌入模型不可用时的字面重合兜底（passage-locator.ts:81-94）：
// 双方各自去空白后取相邻字符对（bigram），得分 = 查询 bigram 在块中的
// 命中比例；查询没有 bigram（空/单字符）得 0。
func bigramScore(a, b string) float64 {
	gramsA := bigrams(a)
	if len(gramsA) == 0 {
		return 0
	}
	gramsB := bigrams(b)
	hit := 0
	for g := range gramsA {
		if _, ok := gramsB[g]; ok {
			hit++
		}
	}
	return float64(hit) / float64(len(gramsA))
}

func bigrams(s string) map[string]struct{} {
	var b strings.Builder
	for _, r := range s {
		if isJSWhitespace(r) {
			continue // \s+ 全部移除
		}
		b.WriteRune(r)
	}
	t := []rune(b.String())
	out := make(map[string]struct{})
	for i := 0; i+1 < len(t); i++ {
		out[string(t[i:i+2])] = struct{}{}
	}
	return out
}

// buildPassageIndex 对应 passage-locator.ts:96-106：分块后批量嵌入；
// 嵌入失败时向量置空（后续打分退化为 bigram），无块返回 nil。
func buildPassageIndex(fileText string) *passageIndex {
	pages, chunks := chunkPages(fileText)
	if len(chunks) == 0 {
		return nil
	}
	vecs := [][]float64{}
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.text
	}
	if v, err := embedMany(texts); err == nil {
		vecs = v
	}
	return &passageIndex{pages: pages, chunks: chunks, vecs: vecs}
}

// getIndexCached 对应 passage-locator.ts:108-118：缓存键纳入文本指纹
// （UTF-16 长度），extracted_text 补提取/更新后旧索引自动失效；
// 构建期间并发调用共享同一份结果（TS 缓存的是 Promise）。
func getIndexCached(key, fileText string) *passageIndex {
	cacheKey := key + "::" + strconv.Itoa(utf16Len(fileText))
	passageMu.Lock()
	if e, ok := passageCache[cacheKey]; ok {
		touchLocked(cacheKey)
		passageMu.Unlock()
		<-e.done
		return e.idx
	}
	e := &passageCacheEntry{done: make(chan struct{})}
	passageCache[cacheKey] = e
	touchLocked(cacheKey)
	passageMu.Unlock()

	e.idx = buildPassageIndex(fileText) // 可能耗时（嵌入），不持锁
	close(e.done)
	return e.idx
}

// coverSignals 对应封面/简介块的内容信号词（passage-locator.ts:125）。
var coverSignals = []string{"本资料根据", "教材整理", "课件", "来源：", "目录", "涵盖第", "学习资料", "整理"}

// looksLikeCover 封面/简介块识别（passage-locator.ts:122-127）：位置（第 0 块）
// 与内容信号双重判断——标题开头（1~3 个 # 加空白，/^#{1,3}\s/）且含信号词；
// 超过 600 字或无标题记号的块不算封面。单独看位置不可靠（笔记可能内容直开）。
func looksLikeCover(text string) bool {
	t := trimJS(text)
	if t == "" || utf16Len(t) > 600 {
		return false
	}
	r := []rune(t)
	n := 0
	for n < len(r) && r[n] == '#' {
		n++
	}
	// /^#{1,3}\s/：1~3 个 # 紧跟空白；4 个及以上 # 不匹配（与 JS 一致）
	if n < 1 || n > 3 || n >= len(r) || !isJSWhitespace(r[n]) {
		return false
	}
	for _, sig := range coverSignals {
		if strings.Contains(t, sig) {
			return true
		}
	}
	return false
}

// LocatePassage 在单份文件全文里定位与问题最相关的文段
// （passage-locator.ts:133-176，两阶段检索的 Stage 2）。
//
// 行为契约：
//   - 按 \f 分页（预处理约定），页内 ~500 字分块（断点优先换行、其次句末
//     标点），单文件最多 300 块；短于 20 字的块丢弃
//   - 分块向量惰性缓存：LRU 上限 20 个文件；缓存键 = cacheKey + "::" + 文本长度
//     （extracted_text 更新后旧索引自动失效）
//   - 嵌入不可用时退化为 bigram 字面重合打分
//   - 第一轮跳过「封面块」（第 0 块且命中封面特征），正文全低于阈值时
//     第二轮放开兜底；最终分数 < 0.2（MIN_SCORE）返回 nil 表示未定位到
//
// TS 版整个函数包在 try/catch 里、任何异常都返回 null，因此这里 error
// 恒为 nil——“未定位到”与“内部失败”统一表现为 (nil, nil)。
// ctx 为签名契约保留（TS 无取消语义，内部嵌入走 60s 请求级超时）。
func LocatePassage(ctx context.Context, cacheKey, fileText, query string) (*PassageHit, error) {
	idx := getIndexCached(cacheKey, fileText)
	if idx == nil || len(idx.chunks) == 0 {
		return nil, nil
	}

	var queryVec []float64
	if v, err := embedOne(query); err == nil {
		queryVec = v
	}

	best := -1
	bestScore := -1.0
	for round := 0; round < 2; round++ {
		for i := range idx.chunks {
			// 第一轮跳过封面块；正文全部低于阈值时第二轮放开兜底（TS:151-166）
			if round == 0 && i == 0 && looksLikeCover(idx.chunks[0].text) {
				continue
			}
			var score float64
			if queryVec != nil {
				// TS：idx.vecs[i] || []——向量缺失时余弦按 NaN 处理、该块必被
				// 阈值过滤；Go 的 CosineSimilarity 对空向量得 0，同样出局
				var vec []float64
				if i < len(idx.vecs) {
					vec = idx.vecs[i]
				}
				score = CosineSimilarity(queryVec, vec)
			} else {
				score = bigramScore(query, idx.chunks[i].text)
			}
			if score > bestScore {
				bestScore = score
				best = i
			}
		}
		if best >= 0 && bestScore >= minPassageScore {
			break
		}
	}
	if best < 0 || bestScore < minPassageScore {
		return nil, nil
	}
	return &PassageHit{
		PageNumber: idx.chunks[best].page,
		Text:       idx.chunks[best].text,
		Score:      bestScore,
	}, nil
}
