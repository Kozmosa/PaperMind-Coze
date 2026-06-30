/**
 * Embedding utility — BAAI/bge-small-zh-v1.5 optimized for Chinese text.
 */
import { pipeline, env } from '@huggingface/transformers';

// HuggingFace mirror for China
env.remoteHost = 'https://hf-mirror.com';
env.allowRemoteModels = true;
env.cacheDir = './.cache/huggingface';

const MODEL_NAME = 'Xenova/bge-small-zh-v1.5';

let embedPipeline: any = null;

async function getPipeline() {
  if (!embedPipeline) {
    console.log(`[embedding] Loading model: ${MODEL_NAME}...`);
    embedPipeline = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' });
    console.log('[embedding] Model loaded');
  }
  return embedPipeline;
}

/**
 * Generate embedding vector for a text string.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  // BGE models don't need prefix; just use text directly
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await getPipeline();
  const results = await Promise.all(
    texts.map(t => pipe(t, { pooling: 'mean', normalize: true }))
  );
  return results.map((r: any) => Array.from(r.data));
}

/**
 * Cosine similarity between two normalized vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Find top-K most similar items from candidates.
 */
export function findTopK(
  queryVec: number[],
  candidates: { id: string; name: string; vec: number[] }[],
  k: number,
  threshold = 0.5
): { id: string; name: string; score: number }[] {
  const scored = candidates
    .map(c => ({ id: c.id, name: c.name, score: cosineSimilarity(queryVec, c.vec) }))
    .filter(c => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
