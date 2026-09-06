/** 扫描件重分类：对课程映射模板摘要/pending 的扫描件，用入库提取文本（视觉分析产物）重新生成摘要与分类 */
import { createRequire } from 'node:module';
import * as path from 'path';
const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.COZE_SUPABASE_URL!, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!);
const API = 'http://localhost:9091/api/v1';
const { data } = await supabase
  .from('materials')
  .select('id, name, papercore, process_status, tags, logical_path')
  .not('extracted_text', 'is', null);
const targets = (data || []).filter((m: any) => {
  const isTpl = /^.+课程资料：/.test(m.papercore || '');
  // 路径与 tags 不一致：logical_path 含 tags 里没有的 L3（课程映射时代遗留）
  let paths: string[] = [];
  try { paths = JSON.parse(m.logical_path || '[]'); } catch {}
  const tagL3s = new Set((m.tags || []).filter((t: string) => t !== '数学' && t !== '运筹学'));
  const pathMismatch = paths.some((p: string) => {
    const seg = p.replace(/^\/|\/$/g, '').split('/').pop();
    return seg && !tagL3s.has(seg);
  });
  return isTpl || m.process_status === 'pending' || pathMismatch;
});
console.log(`待重分类 ${targets.length} 份：`);
for (const t of targets) console.log('  -', t.name);
// 清掉旧分类路径：课程映射时代的 logical_path 与 AI 派生路径语义不同，
// 不清会导致 tags 更新而文件夹路径保留旧值（issue：扫描件分类结构错位）
for (const t of targets) {
  await supabase
    .from('materials')
    .update({ logical_path: null, ai_processed: false, process_status: 'pending' })
    .eq('id', t.id);
}
for (const t of targets) {
  const r = await fetch(`${API}/knowledge-builder/process-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'material', id: t.id }),
  });
  const j: any = await r.json().catch(() => ({}));
  console.log(`✅ ${t.name} → HTTP ${r.status}`, j?.data?.status || '');
}
