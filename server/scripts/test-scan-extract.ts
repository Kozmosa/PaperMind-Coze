/** 扫描件视觉提取自检：extractText 对 Bi_ORC 扫描件应自动走视觉 OCR 兜底 */
import { extractText } from '../src/utils/extract-text.js';
import * as path from 'path';

async function main() {
  const file = process.argv[2] || 'Bi_ORC10(Lecture1).pdf';
  const p = path.resolve(process.cwd(), '..', 'test_data', 'legacy-mvp1', file);
  console.log('测试:', p);
  const r = await extractText(p, 'application/pdf', file);
  console.log('提取长度:', r.text.length, '页数:', r.pageCount);
  console.log('前 500 字:');
  console.log(r.text.slice(0, 500));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
