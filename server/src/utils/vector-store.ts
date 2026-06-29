import { embed, findTopK, cosineSimilarity } from './embedding.js';

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
   * Add new tags to the store (for incremental updates)
   */
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
  searchL1(docVec: number[], topK = 3): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L1');
    return findTopK(docVec, candidates, topK, 0.4).map(c => ({ name: c.name, score: c.score }));
  }

  /**
   * Search for the most similar L2 tags to a document embedding
   */
  searchL2(docVec: number[], topK = 5): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L2');
    return findTopK(docVec, candidates, topK, 0.4).map(c => ({ name: c.name, score: c.score }));
  }

  /**
   * Search for the most similar L3 tags to a document embedding
   */
  searchL3(docVec: number[], topK = 10): { name: string; score: number }[] {
    const candidates = this.tags.filter(t => t.level === 'L3');
    return findTopK(docVec, candidates, topK, 0.4).map(c => ({ name: c.name, score: c.score }));
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
