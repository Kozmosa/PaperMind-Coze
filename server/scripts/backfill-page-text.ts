/** PDF 逐页提取回填：整本提取的旧 extracted_text 重提为 \f 分页版本（引用页数定位需要） */
import { createRequire } from 'node:module';
import * as path from 'path';
import * as fs from 'fs';
const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });
const { createClient } = await import('@supabase/supabase-js');
const { extractText } = await import('../src/utils/extract-text.js');
const supabase = createClient(process.env.COZE_SUPABASE_URL!, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!);
const { data: mats } = await supabase
  .from('materials')
  .select('id, name, file_path, file_type, extracted_text')
  .not('extracted_text', 'is', null);
const uploadsDir = path.join(process.cwd(), 'uploads');
const testDataDir = path.resolve(process.cwd(), '..', 'test_data', '学习资料');
const targets = (mats || []).filter((m: any) => {
  if (String(m.extracted_text || '').includes('\f')) return false; // 已是分页版
  // 讲义类材料文件名不带扩展名：按磁盘实际扩展名判断是否 PDF
  let fp: string | null = null;
  const c1 = path.join(uploadsDir, (m.file_path || '').replace(/^\/uploads\//, ''));
  if (fs.existsSync(c1)) fp = c1;
  if (!fp) {
    const c2 = path.join(testDataDir, m.name || '');
    if (fs.existsSync(c2)) fp = c2;
  }
  return !!fp && path.extname(fp).toLowerCase() === '.pdf';
});
console.log(`待逐页重提 ${targets.length} 份 PDF`);
let done = 0;
for (const m of targets) {
  let fp: string | null = null;
  const c1 = path.join(uploadsDir, (m.file_path || '').replace(/^\/uploads\//, ''));
  if (fs.existsSync(c1)) fp = c1;
  if (!fp) {
    const c2 = path.join(testDataDir, m.name || '');
    if (fs.existsSync(c2)) fp = c2;
  }
  if (!fp) { console.log(`[${++done}/${targets.length}] ${(m.name||'').slice(0,30)} → 文件不存在，跳过`); continue; }
  const r = await extractText(fp, 'application/pdf', m.name || '');
  const text = (r.text || '').slice(0, 200000);
  const pages = text.split('\f').filter(Boolean).length;
  if (text.trim().length >= 5) {
    const { error } = await supabase.from('materials').update({ extracted_text: text }).eq('id', m.id);
    console.log(`[${++done}/${targets.length}] ${(m.name||'').slice(0,30)} → ${text.length} 字 / ${pages} 页${error ? ' ❌' + error.message : ''}`);
  } else console.log(`[${++done}/${targets.length}] ${(m.name||'').slice(0,30)} → 提取为空`);
}
console.log('回填完成');
