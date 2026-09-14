/** 重跑 150 字兜底摘要的纪要（thinking-budget bug 遗留：papercore = 原文前 150 字） */
import { createRequire } from 'node:module';
import * as path from 'path';
const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.COZE_SUPABASE_URL!, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!);
const API = 'http://localhost:9091/api/v1';
const { data } = await supabase.from('study_notes').select('id, title, papercore');
const targets = (data || []).filter((n: any) => {
  const len = (n.papercore || '').length;
  return len >= 148 && len <= 152;
});
console.log(`150 字兜底纪要 ${targets.length} 份:`);
for (const t of targets) console.log('  -', t.title);
for (const t of targets) {
  await supabase.from('study_notes').update({ ai_processed: false, process_status: 'pending' }).eq('id', t.id);
}
await Promise.all(targets.map(async (t) => {
  const r = await fetch(`${API}/knowledge-builder/process-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'study_note', id: t.id }),
  });
  const j: any = await r.json().catch(() => ({}));
  console.log(`✅ ${t.title} → HTTP ${r.status} ${j?.data?.status || ''}`);
}));
