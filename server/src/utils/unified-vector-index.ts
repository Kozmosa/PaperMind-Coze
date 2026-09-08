/**
 * Unified Vector Index
 *
 * In-memory singleton index that embeds papercores from ALL content sources
 * (knowledge_nodes, study_notes, materials + file_contents) using
 * BGE-small-zh-v1.5 and provides semantic search with tag-based re-ranking.
 *
 * Replaces the old KnowledgeVectorIndex which only indexed knowledge_nodes.
 */

import { embed, embedBatch, cosineSimilarity } from './embedding.js';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { tagVectorStore } from './vector-store.js';

// ── Types ──────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  sourceType: 'knowledge_node' | 'study_note' | 'material' | 'file_content';
  sourceId: number | string;
  title: string;
  papercore: string;
  tags: string[];
  pageNumber?: number;
  draftId?: number;
  fileName?: string;
  rawScore: number; // cosine similarity score
  score: number; // final score after tag boosting
}

interface IndexRecord {
  sourceType: UnifiedSearchResult['sourceType'];
  sourceId: number | string;
  title: string;
  papercore: string;
  tags: string[];
  pageNumber?: number;
  draftId?: number;
  fileName?: string;
  vec: number[];
}

// ── Constants ──────────────────────────────────────────────────────

const TAG_BOOST_FACTOR = 0.3; // max score boost from tag matching
const TAG_BOOST_PER_MATCH = 0.1; // per matched tag boost

// ── Index Class ────────────────────────────────────────────────────

class UnifiedVectorIndex {
  private records: IndexRecord[] = [];
  private ready = false;
  private building = false;
  private buildPromise: Promise<void> | null = null;

  isReady(): boolean {
    return this.ready;
  }

  getRecordCount(): number {
    return this.records.length;
  }

  /**
   * Build (or rebuild) the index from all three content tables.
   * 标签库（TagVectorStore）的构建由调用方负责（见 utils/index-refresh.ts）。
   */
  async buildIndex(): Promise<void> {
    if (this.building && this.buildPromise) {
      return this.buildPromise;
    }

    this.building = true;
    this.ready = false;

    this.buildPromise = (async () => {
      try {
        const client = getSupabaseClient();
        const records: IndexRecord[] = [];

        // ── 1. knowledge_nodes 已退出检索（用户设计演进：只剩 文件+L1/L2/L3）──
        // 分类管线会为每份材料同步一条同名影子节点，检索命中会产生与资料
        // 重复的「知识节点」引用卡；图谱显示层已排除，检索层同样跳过。
        // （库中历史影子节点保留，反思助手仍读节点活动，如需彻底清退另议）

        // ── 2. Load study_notes (ai_processed=true, papercore non-empty) ─
        console.log('[UnifiedVectorIndex] Loading study_notes...');
        const { data: studyNotes, error: snErr } = await client
          .from('study_notes')
          .select('id, papercore, tags, title')
          .eq('ai_processed', true)
          .not('papercore', 'is', null)
          .order('created_at', { ascending: false });

        if (snErr) {
          console.error('[UnifiedVectorIndex] study_notes fetch error:', snErr);
        } else if (studyNotes) {
          for (const row of studyNotes) {
            const papercore = (row as any).papercore || '';
            if (papercore.trim()) {
              records.push({
                sourceType: 'study_note',
                sourceId: (row as any).id,
                title: (row as any).title || `学习纪要${(row as any).id}`,
                papercore,
                tags: (row as any).tags || [],
                vec: [], // placeholder
              });
            }
          }
          console.log(
            `[UnifiedVectorIndex]   → ${records.filter((r) => r.sourceType === 'study_note').length} study_notes`,
          );
        }

        // ── 3. Load materials (ai_processed=true, papercore non-empty) ─
        console.log('[UnifiedVectorIndex] Loading materials...');
        const { data: materials, error: mErr } = await client
          .from('materials')
          .select('id, papercore, tags, name')
          .eq('ai_processed', true)
          .not('papercore', 'is', null)
          .order('created_at', { ascending: false });

        if (mErr) {
          console.error('[UnifiedVectorIndex] materials fetch error:', mErr);
        } else if (materials) {
          for (const row of materials) {
            const papercore = (row as any).papercore || '';
            if (papercore.trim()) {
              records.push({
                sourceType: 'material',
                sourceId: (row as any).id,
                title: (row as any).name || `资料${(row as any).id}`,
                papercore,
                tags: (row as any).tags || [],
                vec: [], // placeholder
              });
            }
          }
          console.log(
            `[UnifiedVectorIndex]   → ${records.filter((r) => r.sourceType === 'material').length} materials`,
          );
        }

                // ── 4. file_contents 退出统一索引 ──
        // 两阶段检索：Stage 1 只做文档层（tags+papercore），
        // Stage 2 由 passage-locator 对命中文件的全文做文段级检索

if (records.length === 0) {
          console.log('[UnifiedVectorIndex] No records found, index empty.');
          this.records = [];
          this.ready = true;
          return;
        }

        // ── 5. Embed docs: papercore + L1/L2/L3 标签名 ───────────
        console.log(`[UnifiedVectorIndex] Embedding ${records.length} records...`);
        // 文档层嵌入 = 摘要 + 全部标签名（分类信号直接参与语义匹配）；
        // 正文不再进文档层——文段级检索由 passage-locator（Stage 2）负责
        const texts = records.map((r: any) => `${r.papercore}\n${(r.tags || []).join(' ')}`);
        const vectors = await embedBatch(texts);

        for (let i = 0; i < records.length; i++) {
          records[i].vec = vectors[i];
        }

        this.records = records;
        this.ready = true;
        console.log(
          `[UnifiedVectorIndex] Index built: ${this.records.length} records (kn:${records.filter((r) => r.sourceType === 'knowledge_node').length} sn:${records.filter((r) => r.sourceType === 'study_note').length} m:${records.filter((r) => r.sourceType === 'material').length} fc:${records.filter((r) => r.sourceType === 'file_content').length})`,
        );
      } catch (err) {
        console.error('[UnifiedVectorIndex] Build failed:', err);
      } finally {
        this.building = false;
      }
    })();

    return this.buildPromise;
  }

  /**
   * Semantic search with tag-based re-ranking.
   *
   * 1. Embeds the query and computes cosine similarity against all records.
   * 2. Extracts query-relevant tags via TagVectorStore.
   * 3. Boosts records whose tags overlap with query tags.
   * 4. Returns top-K results sorted by boosted score.
   */
  async search(
    query: string,
    topK: number = 10,
    minScore: number = 0.3,
  ): Promise<UnifiedSearchResult[]> {
    if (!this.ready) {
      console.log('[UnifiedVectorIndex] Index not ready, attempting build...');
      try {
        await this.buildIndex();
      } catch {
        return [];
      }
    }

    if (this.records.length === 0) {
      return [];
    }

    try {
      const queryVec = await embed(query);

      // ── Step 1: Raw cosine similarity scoring ─────────────────
      const scored: Array<{
        record: IndexRecord;
        rawScore: number;
        score: number;
      }> = this.records.map((r) => {
        const rawScore = cosineSimilarity(queryVec, r.vec);
        return { record: r, rawScore, score: rawScore };
      });

      // ── Step 2: Tag-based re-ranking ─────────────────────────
      // Use lower threshold for tag similarity, and combine both
      // semantic (cosine) matching AND literal substring / word overlap.
      if (tagVectorStore.isReady && tagVectorStore.count > 0) {
        // Approach A: semantic tag matching (lowered threshold)
        const semL1 = tagVectorStore.searchL1(queryVec, 3, 0.25);
        const semL2 = tagVectorStore.searchL2(queryVec, 5, 0.2);

        const queryTags = new Set([...semL1.map((t) => t.name), ...semL2.map((t) => t.name)]);

        // Approach B: literal word-level matching — if the query
        // contains a tag name as a substring, also treat it as matched.
        for (const tag of tagVectorStore.getAllTags()) {
          if (query.includes(tag)) {
            queryTags.add(tag);
          }
        }

        if (queryTags.size > 0) {
          let boostedCount = 0;
          for (const item of scored) {
            const recordTags = item.record.tags;
            if (recordTags.length === 0) continue;

            const overlapCount = recordTags.filter((t) => queryTags.has(t)).length;
            if (overlapCount > 0) {
              const boost = Math.min(overlapCount * TAG_BOOST_PER_MATCH, TAG_BOOST_FACTOR);
              item.score = item.rawScore * (1 + boost);
              boostedCount++;
            }
          }
          if (boostedCount > 0) {
            console.log(
              `[UnifiedVectorIndex] Tag-boosted ${boostedCount}/${scored.length} records (query tags: ${[...queryTags].join(', ')})`,
            );
          }
        }
      }

      // ── Step 3: Filter by minScore, sort, top-K ───────────────
      const results = scored
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(
          ({ record, rawScore, score }) =>
            ({
              sourceType: record.sourceType,
              sourceId: record.sourceId,
              title: record.title,
              papercore: record.papercore,
              tags: record.tags,
              pageNumber: record.pageNumber,
              draftId: record.draftId,
              fileName: record.fileName,
              rawScore,
              score,
            }) as UnifiedSearchResult,
        );

      return results;
    } catch (err) {
      console.error('[UnifiedVectorIndex] Search failed:', err);
      return [];
    }
  }
}

/** Singleton instance */
export const unifiedVectorIndex = new UnifiedVectorIndex();
