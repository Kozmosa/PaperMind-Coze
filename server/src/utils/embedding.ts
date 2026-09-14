/**
 * Embedding utility —— 走 OpenAI 兼容的 Embedding API（默认 SiliconFlow BAAI/bge-m3，1024 维）。
 *
 * 与早期版本的差别：不再在进程内跑 ONNX（@huggingface/transformers）。原因：
 *   1. 免去首次调用时下载约 100MB 模型；
 *   2. 免去 onnxruntime 原生依赖（含 libgomp1）与数百 MB 镜像体积；
 *   3. 推理是 CPU 密集且阻塞事件循环的，在低配实例上启动预热会把服务堵死数分钟；
 *      走 HTTP 后是纯 I/O，不再阻塞。
 *
 * 环境变量：
 *   EMBEDDING_API_KEY   必填，否则调用时抛错（服务仍可启动，仅嵌入相关链路不可用）
 *   EMBEDDING_API_BASE  可选，默认 https://api.siliconflow.cn/v1
 *   EMBEDDING_MODEL     可选，默认 BAAI/bge-m3（最大输入 8192 token）
 */

const API_BASE = (process.env.EMBEDDING_API_BASE || 'https://api.siliconflow.cn/v1').replace(
  /\/$/,
  '',
);
const API_KEY = process.env.EMBEDDING_API_KEY || '';
const MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';

/** 单次请求携带的文本条数（避免请求体过大，也便于失败时快速重试） */
const BATCH_SIZE = 32;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 60_000;

/** L2 归一化：cosineSimilarity() 用的是点积，必须保证单位向量 */
function normalize(vec: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 请求一批文本的向量。失败时对 429 / 5xx / 网络错误做指数退避重试。
 */
async function requestEmbeddings(inputs: string[]): Promise<number[][]> {
  if (!API_KEY) {
    throw new Error('EMBEDDING_API_KEY is not set — 请在环境变量中配置 Embedding API Key');
  }
  if (inputs.length === 0) return [];

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1)); // 400 / 800 / 1600 / 3200 ms

    try {
      const res = await fetch(`${API_BASE}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, input: inputs, encoding_format: 'float' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 4xx（除 429）属于请求本身的问题，重试无意义
        if (res.status !== 429 && res.status < 500) {
          throw new Error(`Embedding API ${res.status}: ${body.slice(0, 300)}`);
        }
        lastError = new Error(`Embedding API ${res.status}: ${body.slice(0, 300)}`);
        console.warn(`[embedding] 第 ${attempt + 1} 次失败(${res.status})，准备重试`);
        continue;
      }

      const json = (await res.json()) as {
        data?: { embedding: number[]; index?: number }[];
      };
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error(
          `Embedding API 返回条数异常：期望 ${inputs.length} 条，实得 ${data?.length ?? 0} 条`,
        );
      }

      // 按 index 还原顺序（接口不保证返回顺序，缺 index 时按数组顺序）
      const ordered: number[][] = new Array(inputs.length);
      data.forEach((item, i) => {
        const idx = typeof item.index === 'number' ? item.index : i;
        ordered[idx] = normalize(item.embedding);
      });
      return ordered;
    } catch (err) {
      // 参数/鉴权类错误已在上面直接抛出，这里只处理网络与超时
      lastError = err;
      if (err instanceof Error && err.message.startsWith('Embedding API ')) throw err;
      console.warn(`[embedding] 第 ${attempt + 1} 次请求异常：${(err as Error)?.message}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Embedding 请求失败');
}

/**
 * Generate embedding vector for a text string.
 */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await requestEmbeddings([text?.trim() || ' ']);
  return vec;
}

/**
 * Generate embeddings for multiple texts in batch.
 * 自动分片；返回顺序与入参一一对应。
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const vectors = await requestEmbeddings(chunk.map((t) => t?.trim() || ' '));
    results.push(...vectors);
  }
  return results;
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
  threshold = 0.5,
): { id: string; name: string; score: number }[] {
  const scored = candidates
    .map((c) => ({ id: c.id, name: c.name, score: cosineSimilarity(queryVec, c.vec) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
