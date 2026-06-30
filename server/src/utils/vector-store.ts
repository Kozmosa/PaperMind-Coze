import { embed, embedBatch, findTopK, cosineSimilarity } from './embedding.js';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

interface TagEntry {
  id: string;
  name: string;
  level: 'L1' | 'L2' | 'L3';
  parentId?: string;
  vec: number[];
}

/**
 * In-memory vector store for knowledge tags.
 * Stores embeddings for L1, L2, L3 tags with hierarchy metadata.
 */
class TagVectorStore {
  private tags: TagEntry[] = [];
  private initialized = false;

  /**
   * Build the vector store from existing tag hierarchy
   */
  async buildFromHierarchy(hierarchy: { L1: string[]; L2: string[]; L3: string[] }) {
    this.tags = [];

    // Index L1 tags
    for (const name of hierarchy.L1) {
      if (!name) continue;
      const vec = await embed(name);
      this.tags.push({ id: `L1_${name}`, name, level: 'L1', vec });
    }

    // Index L2 tags
    for (const name of hierarchy.L2) {
      if (!name) continue;
      const vec = await embed(name);
      this.tags.push({ id: `L2_${name}`, name, level: 'L2', vec });
    }

    // Index L3 tags
    for (const name of hierarchy.L3) {
      if (!name) continue;
      const vec = await embed(name);
      this.tags.push({ id: `L3_${name}`, name, level: 'L3', vec });
    }

    this.initialized = true;
    console.log(`[vector-store] Indexed ${this.tags.length} tags (L1:${hierarchy.L1.length}, L2:${hierarchy.L2.length}, L3:${hierarchy.L3.length})`);
  }

  /**
   * Build the vector store from all three content tables.
   * Extracts and deduplicates tags from knowledge_nodes, study_notes, and materials.
   */
  async buildFromDatabase(): Promise<void> {
    this.tags = [];
    const client = getSupabaseClient();

    const allTags = new Map<string, 'L1' | 'L2' | 'L3'>();

    // Helper to extract L1/L2/L3 from a tags array
    const collectTags = (tagsArray: string[] | null | undefined) => {
      if (!tagsArray || !Array.isArray(tagsArray)) return;
      for (let i = 0; i < tagsArray.length; i++) {
        const name = tagsArray[i]?.trim();
        if (!name) continue;
        // Infer level from position: index 0 = L1, index 1 = L2, index 2+ = L3
        const level: 'L1' | 'L2' | 'L3' = i === 0 ? 'L1' : i === 1 ? 'L2' : 'L3';
        const key = `${level}_${name}`;
        if (!allTags.has(key)) {
          allTags.set(key, level);
        }
      }
    };

    try {
      // ── Fetch tags from all three tables ─────────────────
      const [knRes, snRes, mRes] = await Promise.all([
        client.from('knowledge_nodes').select('tags').not('tags', 'is', null).limit(5000),
        client.from('study_notes').select('tags').not('tags', 'is', null).limit(5000),
        client.from('materials').select('tags').not('tags', 'is', null).limit(5000),
      ]);

      if (knRes.data) knRes.data.forEach((row: any) => collectTags(row.tags));
      if (snRes.data) snRes.data.forEach((row: any) => collectTags(row.tags));
      if (mRes.data) mRes.data.forEach((row: any) => collectTags(row.tags));

      console.log(`[vector-store] Collected ${allTags.size} unique tags from DB`);

      // ── Embed all tags ───────────────────────────────────
      if (allTags.size === 0) {
        this.initialized = true;
        return;
      }

      const entries = [...allTags.entries()];
      const names = entries.map(([, name]) => name); // extract name from entries
      const vecs = await embedBatch(names);

      this.tags = entries.map(([key, level], idx) => {
        // key is 'L1_<name>' etc, we need to extract the name
        const name = key.slice(3); // strip 'L1_' / 'L2_' / 'L3_' prefix
        return {
          id: key,
          name,
          level,
          vec: vecs[idx],
        };
      });

      const l1Count = this.tags.filter(t => t.level === 'L1').length;
      const l2Count = this.tags.filter(t => t.level === 'L2').length;
      const l3Count = this.tags.filter(t => t.level === 'L3').length;
      this.initialized = true;
      console.log(`[vector-store] Indexed ${this.tags.length} tags from DB (L1:${l1Count}, L2:${l2Count}, L3:${l3Count})`);
    } catch (err) {
      console.error('[vector-store] buildFromDatabase failed:', err);
      this.initialized = false;
    }
  }
  async addTags(tags: { name: string; level: 'L1' | 'L2' | 'L3' }[]) {
    for (const tag of tags) {
      if (!tag.name) continue;
      // Skip if already exists
      if (this.tags.some(t => t.id === `${tag.level}_${tag.name}`)) continue;
      const vec = await embed(tag.name);
      this.tags.push({ id: `${tag.level}_${tag.name}`, name: tag.name, level: tag.level, vec });
    }
  }

  /**
   * Search for the most similar L1 tags to a document embedding
   */
  searchL1(docVec: number[], topK = 3, minScore = 0.4): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L1');
    return findTopK(docVec, candidates, topK, minScore).map(c => ({ name: c.name, score: c.score }));
  }

  /**
   * Search for the most similar L2 tags to a document embedding
   */
  searchL2(docVec: number[], topK = 5, minScore = 0.4): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L2');
    return findTopK(docVec, candidates, topK, minScore).map(c => ({ name: c.name, score: c.score }));
  }

  /**
   * Search for the most similar L3 tags to a document embedding
   */
  searchL3(docVec: number[], topK = 10, minScore = 0.4): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L3');
    return findTopK(docVec, candidates, topK, minScore).map(c => ({ name: c.name, score: c.score }));
  }

  /**
   * Return all tag names as a flat string array (for literal matching).
   */
  getAllTags(): string[] {
    return this.tags.map(t => t.name);
  }

  /**
   * Get count of indexed tags
   */
  get count() {
    return this.tags.length;
  }

  get isReady() {
    return this.initialized;
  }
}

// Singleton instance
export const tagVectorStore = new TagVectorStore();
