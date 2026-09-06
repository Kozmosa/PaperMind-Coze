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
  .select('id, name, papercore, process_status')
  .not('extracted_text', 'is', null);
const targets = (data || []).filter((m: any) => {
  const isTpl = /^.+课程资料：/.test(m.papercore || '');
  return isTpl || m.process_status === 'pending';
});
console.log(`待重分类 ${targets.length} 份：`);
for (const t of targets) console.log('  -', t.name);
for (const t of targets) {
  const r = await fetch(`${API}/knowledge-builder/process-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'material', id: t.id }),
  });
  const j: any = await r.json().catch(() => ({}));
  console.log(`✅ ${t.name} → HTTP ${r.status}`, j?.data?.status || '');
}
