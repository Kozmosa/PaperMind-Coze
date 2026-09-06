/**
 * PPT 解析自检：对 test_data/legacy-mvp1 下的 .pptx 文件跑 extractText，
 * 打印提取长度/页数/文本样例，确认解析链路正常。
 * 用法：cd server && npx tsx scripts/test-pptx-extract.ts
 */
import { extractText } from '../src/utils/extract-text.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const dir = path.resolve(process.cwd(), '..', 'test_data', 'legacy-mvp1');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pptx'));
  console.log(`找到 ${files.length} 个 .pptx 文件\n`);
  for (const f of files.slice(0, 4)) {
    const r = await extractText(
      path.join(dir, f),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      f,
    );
    console.log(`=== ${f} ===`);
    console.log(`  长度 ${r.text.length}，页数 ${r.pageCount}`);
    console.log(`  样例: ${JSON.stringify(r.text.slice(0, 120))}\n`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
