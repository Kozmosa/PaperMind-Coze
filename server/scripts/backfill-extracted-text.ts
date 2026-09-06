/**
 * 回填 materials.extracted_text（迁移 005 后的存量数据）：
 * 对 extracted_text 为空的资料从磁盘提取（扫描件走视觉分析，有磁盘缓存），写回资料表。
 * 用法：cd server && npx tsx scripts/backfill-extracted-text.ts
 */
import { createRequire } from 'node:module';
import * as path from 'path';
import * as fs from 'fs';

const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve('.env') });

async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const { extractText } = await import('../src/utils/extract-text.js');
  const supabase = createClient(
    process.env.COZE_SUPABASE_URL,
    process.env.COZE_SUPABASE_SERVICE_ROLE_KEY,
  );
  const { data: materials } = await supabase
    .from('materials')
    .select('id, name, file_path, file_type, extracted_text')
    .is('extracted_text', null);
  if (!materials || materials.length === 0) {
    console.log('没有需要回填的资料。');
    return;
  }
  console.log(`待回填 ${materials.length} 份资料\n`);

  const uploadsDir = path.join(process.cwd(), 'uploads');
  const testDataDir = path.resolve(process.cwd(), '..', 'test_data', '学习资料');
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };

  let done = 0;
  for (const m of materials) {
    const t0 = Date.now();
    let filePath: string | null = null;
    const stored = m.file_path || '';
    const candidate = path.join(uploadsDir, stored.replace(/^\/uploads\//, ''));
    if (fs.existsSync(candidate)) filePath = candidate;
    if (!filePath) {
      const c2 = path.join(testDataDir, m.name || '');
      if (fs.existsSync(c2)) filePath = c2;
    }
    if (!filePath) {
      console.log(`[${++done}/${materials.length}] ${(m.name || '').slice(0, 30)} → 磁盘文件不存在，跳过`);
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    const extracted = await extractText(filePath, mimeMap[ext] || 'application/octet-stream', path.basename(filePath));
    const text = (extracted.text || '').slice(0, 200000);
    if (text.trim().length >= 5) {
      const { error } = await supabase.from('materials').update({ extracted_text: text }).eq('id', m.id);
      console.log(`[${++done}/${materials.length}] ${(m.name || '').slice(0, 30)} → ${text.length} 字（${((Date.now() - t0) / 1000).toFixed(1)}s）${error ? ' ❌ ' + error.message : ''}`);
    } else {
      console.log(`[${++done}/${materials.length}] ${(m.name || '').slice(0, 30)} → 提取为空，跳过`);
    }
  }
  console.log('\n回填完成。');
}

main()
  .catch((e) => {
    console.error('回填失败:', e.message);
    process.exit(1);
  });
