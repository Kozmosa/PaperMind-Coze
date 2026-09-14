/** 定向补 OCR：指定材料从 startPage 起补提取至 totalPages，追加到 extracted_text */
import { createRequire } from 'node:module';
import * as path from 'path';
import * as fs from 'fs';
const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.COZE_SUPABASE_URL!, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!);
const NAME = process.argv[2] || 'Bi_ORC10(Lecture1)';
const START = parseInt(process.argv[3] || '21', 10); // 1-based 起始页
const { data: m } = await supabase.from('materials').select('id,name,file_path,extracted_text').eq('name', NAME).single();
if (!m) { console.log('未找到材料:', NAME); process.exit(1); }
const fp = path.join(process.cwd(), 'uploads', (m.file_path || '').replace(/^\/uploads\//, ''));
if (!fs.existsSync(fp)) { console.log('文件不存在:', fp); process.exit(1); }
const mupdf = await import('mupdf');
const doc = mupdf.Document.openDocument(fs.readFileSync(fp), 'application/pdf');
const total = doc.countPages();
const VISION_CONFIG = (await import('../src/config/ai.js')).VISION_CONFIG;
const pages = (m.extracted_text || '').split('\f');
// 逐页补 OCR（复用 OpenAI 格式调用）
for (let i = START - 1; i < total; i++) {
  const page = doc.loadPage(i);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
  const b64 = Buffer.from(pixmap.asPNG()).toString('base64');
  const resp = await fetch(`${VISION_CONFIG.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VISION_CONFIG.apiKey}` },
    body: JSON.stringify({ model: VISION_CONFIG.model, max_tokens: 2048, messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      { type: 'text', text: '请识别这张课件页面的全部文字内容（标题、正文；公式用 LaTeX 表达），按原文顺序输出，不要添加解释或客套话。' },
    ] }] }),
  });
  const j: any = await resp.json().catch(() => ({}));
  const t = (j.choices?.[0]?.message?.content || '').trim();
  console.log(`第${i + 1}页 → ${t ? t.length + ' 字' : '失败'}:`, JSON.stringify(t.slice(0, 50)));
  pages[i] = t || pages[i] || '';
}
const text = pages.map((p: string) => (p || '').trim()).filter(Boolean).join('\f');
const { error } = await supabase.from('materials').update({ extracted_text: text }).eq('id', m.id);
console.log(error ? '❌ ' + error.message : `✅ ${NAME} 更新完成：${pages.filter((p: string) => p && p.trim()).length} 页 / ${text.length} 字`);
