/**
 * Knowledge Node Vector Index
 *
 * In-memory singleton index that embeds knowledge node papercores
 * using BGE-small-zh-v1.5 and provides semantic search via cosine similarity.
 *
 * Falls back gracefully when the embedding model is not yet loaded.
 */

import { embed, embedBatch, cosineSimilarity } from './embedding.js';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

export interface IndexedNode {
  id: number;
  short_name: string;
  papercore: string;
  tags: string[];
  vec: number[];
}

export interface SearchResult {
  id: number;
  short_name: string;
  papercore: string;
  tags: string[];
  score: number;
}

class KnowledgeVectorIndex {
  private nodes: IndexedNode[] = [];
  private ready = false;
  private building = false;
  private buildPromise: Promise<void> | null = null;

  isReady(): boolean {
    return this.ready;
  }

  getNodeCount(): number {
    return this.nodes.length;
  }

  /**
   * Build (or rebuild) the index from all knowledge_nodes in the database.
   * Safe to call multiple times — concurrent calls share the same build.
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

        console.log('[KnowledgeVectorIndex] Fetching knowledge nodes...');
        const { data: rows, error } = await client
          .from('knowledge_nodes')
          .select('id, papercore, tags, short_name')
          .order('created_at', { ascending: false });

        if (error) {
          console.error('[KnowledgeVectorIndex] DB fetch error:', error);
          return;
        }

        if (!rows || rows.length === 0) {
          console.log('[KnowledgeVectorIndex] No nodes found, index empty.');
          this.nodes = [];
          this.ready = true;
          return;
        }

        const texts: string[] = [];
        const meta: Array<{ id: number; short_name: string; papercore: string; tags: string[] }> = [];

        for (const row of rows) {
          const papercore = (row as any).papercore || '';
          if (papercore.trim()) {
            texts.push(papercore);
            meta.push({
              id: (row as any).id,
              short_name: (row as any).short_name || '',
              papercore,
              tags: (row as any).tags || [],
            });
          }
        }

        if (texts.length === 0) {
          console.log('[KnowledgeVectorIndex] No papercores to embed, index empty.');
          this.nodes = [];
          this.ready = true;
          return;
        }

        console.log(`[KnowledgeVectorIndex] Embedding ${texts.length} nodes...`);
        const vectors = await embedBatch(texts);

        this.nodes = meta.map((m, i) => ({
          ...m,
          vec: vectors[i],
        }));

        this.ready = true;
        console.log(`[KnowledgeVectorIndex] Index built: ${this.nodes.length} nodes.`);
      } catch (err) {
        console.error('[KnowledgeVectorIndex] Build failed:', err);
        // Don't mark ready on failure
      } finally {
        this.building = false;
      }
    })();

    return this.buildPromise;
  }

  /**
   * Search for semantically similar nodes.
   * Returns an empty array if the index is not ready.
   */
  async search(query: string, topK: number = 10, minScore: number = 0.3): Promise<SearchResult[]> {
    if (!this.ready) {
      console.log('[KnowledgeVectorIndex] Index not ready, attempting build...');
      try {
        await this.buildIndex();
      } catch {
        return [];
      }
    }

    if (this.nodes.length === 0) {
      return [];
    }

    try {
      const queryVec = await embed(query);

      const scored = this.nodes
        .map((n) => ({
          id: n.id,
          short_name: n.short_name,
          papercore: n.papercore,
          tags: n.tags,
          score: cosineSimilarity(queryVec, n.vec),
        }))
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score);

      return scored.slice(0, topK);
    } catch (err) {
      console.error('[KnowledgeVectorIndex] Search failed:', err);
      return [];
    }
  }
}

/** Singleton instance */
export const knowledgeVectorIndex = new KnowledgeVectorIndex();
