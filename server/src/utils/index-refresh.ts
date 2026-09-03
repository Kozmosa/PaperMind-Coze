/**
 * 索引防抖重建：合并 5 秒内的多次写操作，避免每次建节点/分类都全量重建。
 * 重建顺序：先标签库（供加成使用），再统一向量索引。
 */
let timer: NodeJS.Timeout | null = null;

export function scheduleIndexRebuild(delayMs = 5000): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    import('./unified-vector-index.js').then(async (indexMod) => {
      try {
        await import('./vector-store.js').then((tagMod) =>
          tagMod.tagVectorStore.buildFromDatabase()
        );
      } catch (err: any) {
        console.warn('[Index] TagVectorStore rebuild failed:', err?.message);
      }
      await indexMod.unifiedVectorIndex.buildIndex().catch((err: any) => {
        console.warn('[Index] UnifiedVectorIndex rebuild failed:', err?.message);
      });
    }).catch(() => {
      // embedding deps 不可用 — 忽略
    });
  }, delayMs);
}
