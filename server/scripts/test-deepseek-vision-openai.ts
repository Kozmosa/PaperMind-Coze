/** 用 OpenAI 兼容格式测试 deepseek-v4-flash-vision-exp 的视觉输入 */
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const mupdf = await import('mupdf');
  const pdfPath = path.resolve(process.cwd(), '..', 'test_data', 'legacy-mvp1', 'Bi_ORC10(Lecture1).pdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), 'application/pdf');
  const page = doc.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
  const b64 = Buffer.from(pixmap.asPNG()).toString('base64');
  console.log(`渲染 OK（${(b64.length / 1024).toFixed(0)}KB base64）`);

  const key = process.env.ANTHROPIC_API_KEY;
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash-vision-exp',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            { type: 'text', text: '请识别这张课件页面的全部文字内容（标题、正文；公式用 LaTeX 表达），按原文顺序输出。' },
          ],
        },
      ],
    }),
  });
  const j: any = await resp.json();
  if (j.error) {
    console.log('API 错误:', JSON.stringify(j.error).slice(0, 300));
    return;
  }
  const text = j.choices?.[0]?.message?.content || '';
  console.log(`响应（${text.length} 字）:`);
  console.log(text.slice(0, 400));
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
