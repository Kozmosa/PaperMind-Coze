/** 扫描件重新视觉提取（OCR 页数 5→15）：补齐正文后半部分，供文段定位 */
import { createRequire } from 'node:module';
import * as path from 'path';
import * as fs from 'fs';
const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });
const { createClient } = await import('@supabase/supabase-js');
const { extractText } = await import('../src/utils/extract-text.js');
const supabase = createClient(process.env.COZE_SUPABASE_URL!, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!);
const { data: matsRaw } = await supabase.from('materials').select('id,name,file_path').like('name', 'Bi_ORC%');
const mats = matsRaw || [];
console.log(`待重提取 ${mats.length} 份扫描件（15 页视觉 OCR）`);
const uploadsDir = path.join(process.cwd(), 'uploads');
let done = 0;
for (const m of mats) {
  const fp = path.join(uploadsDir, (m.file_path || '').replace(/^\/uploads\//, ''));
  if (!fs.existsSync(fp)) { console.log(`[${++done}/${mats.length}] ${m.name} → 文件不存在`); continue; }
  const t0 = Date.now();
  const r = await extractText(fp, 'application/pdf', m.name || '');
  const text = (r.text || '').slice(0, 200000);
  const pages = text.split('\f').filter(Boolean).length;
  if (text.trim().length >= 5) {
    const { error } = await supabase.from('materials').update({ extracted_text: text }).eq('id', m.id);
    console.log(`[${++done}/${mats.length}] ${m.name} → ${text.length} 字 / ${pages} 页（${((Date.now()-t0)/1000).toFixed(0)}s）${error?' ❌'+error.message:''}`);
  }
}
console.log('重提取完成');
