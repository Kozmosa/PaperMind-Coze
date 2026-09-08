/**
 * 文段定位器（两阶段检索的 Stage 2）
 *
 * Stage 1（unified-vector-index）文档层命中资料后，本模块对命中文档的
 * 全文做文段级检索，返回精确页码与相关文段：
 * - 按 \f 分页（预处理约定），页内 ~500 字分块
 * - 分块向量惰性缓存：文件第一次被命中时才构建，之后复用
 * - 问题向量与块向量余弦打分取最优块；嵌入不可用时退化为 bigram 字面重合
 */

import { embed, embedBatch, cosineSimilarity } from './embedding.js';

const CHUNK_SIZE = 500; // 块字符数
const MAX_CHUNKS_PER_FILE = 300; // 超大文件截断（150K 字覆盖）
const MIN_SCORE = 0.2; // 低于阈值视为未定位到文段
const CACHE_MAX_FILES = 20; // 惰性缓存文件数上限（LRU）

export interface PassageHit {
  pageNumber: number;
  text: string; // 命中块文字
  score: number;
}

interface PassageIndex {
  pages: string[];
  chunks: { page: number; text: string }[];
  vecs: number[][];
}

const cache = new Map<string, Promise<PassageIndex | null>>();
const cacheOrder: string[] = [];

function touch(key: string): void {
  const i = cacheOrder.indexOf(key);
  if (i >= 0) cacheOrder.splice(i, 1);
  cacheOrder.push(key);
  while (cacheOrder.length > CACHE_MAX_FILES) {
    const evict = cacheOrder.shift();
    if (evict) cache.delete(evict);
  }
}

function chunkPages(text: string): { pages: string[]; chunks: { page: number; text: string }[] } {
  const pages = String(text || '')
    .split('\f')
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: { page: number; text: string }[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    if (p.length <= CHUNK_SIZE) {
      if (p.length >= 20) chunks.push({ page: pi + 1, text: p });
      continue;
    }
    for (let s = 0; s < p.length && chunks.length < MAX_CHUNKS_PER_FILE; s += CHUNK_SIZE) {
      const piece = p.slice(s, s + CHUNK_SIZE).trim();
      if (piece.length >= 20) chunks.push({ page: pi + 1, text: piece });
    }
  }
  return { pages, chunks };
}

// bigram 字面重合兜底（嵌入模型不可用时）
function bigramScore(a: string, b: string): number {
  const make = (s: string) => {
    const t = String(s || '').replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = make(a);
  if (A.size === 0) return 0;
  const B = make(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}

async function buildIndex(fileText: string): Promise<PassageIndex | null> {
  const { pages, chunks } = chunkPages(fileText);
  if (chunks.length === 0) return null;
  let vecs: number[][] = [];
  try {
    vecs = await embedBatch(chunks.map((c) => c.text));
  } catch {
    vecs = [];
  }
  return { pages, chunks, vecs };
}

function getIndexCached(key: string, fileText: string): Promise<PassageIndex | null> {
  let p = cache.get(key);
  if (!p) {
    p = buildIndex(fileText);
    cache.set(key, p);
  }
  touch(key);
  return p;
}

/**
 * 在单份文件的全文里定位与问题最相关的文段。
 * @returns 命中块（页码+文字+分数）；未过阈值返回 null
 */
export async function locatePassage(
  cacheKey: string,
  fileText: string,
  query: string,
): Promise<PassageHit | null> {
  try {
    const idx = await getIndexCached(cacheKey, fileText);
    if (!idx || idx.chunks.length === 0) return null;

    let queryVec: number[] | null = null;
    try {
      queryVec = await embed(query);
    } catch {
      queryVec = null;
    }

    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < idx.chunks.length; i++) {
      const score = queryVec
        ? cosineSimilarity(queryVec, idx.vecs[i] || [])
        : bigramScore(query, idx.chunks[i].text);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0 || bestScore < MIN_SCORE) return null;
    return {
      pageNumber: idx.chunks[best].page,
      text: idx.chunks[best].text,
      score: bestScore,
    };
  } catch {
    return null;
  }
}
