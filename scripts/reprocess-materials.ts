/**
 * 重新处理所有 material 的 AI 摘要
 * 从本地 test_data 重新读取文件内容，调用 process-content API
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND = 'http://localhost:9091';
const TEST_DATA_DIR = path.resolve(__dirname, '..', 'test_data', '学习资料');
const USER_ID = 'debug_user_001';

// ========== 文件提取函数（与 knowledge-builder.ts 保持一致） ==========
async function extractFileContent(
  buffer: Buffer,
  ext: string
): Promise<{ text: string; status: 'ok' | 'unsupported' | 'empty' }> {
  if (ext === '.pdf') {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const text = (result.text || '').trim();
      return { text, status: text.length > 0 ? 'ok' : 'empty' };
    } catch (e: any) {
      return { text: '', status: 'empty' };
    }
  }

  if (ext === '.pptx') {
    try {
      const AdmZip = (await import('adm-zip')).default;
      const { parseStringPromise } = await import('xml2js');

      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const slideFiles = entries
        .filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml/i))
        .sort((a, b) => a.entryName.localeCompare(b.entryName));

      const allTexts: string[] = [];
      for (const slide of slideFiles) {
        const xml = slide.getData().toString('utf8');
        const parsed = await parseStringPromise(xml);

        function collectText(obj: any) {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) { obj.forEach(collectText); return; }
          if (obj['a:t']) {
            const values = Array.isArray(obj['a:t']) ? obj['a:t'] : [obj['a:t']];
            values.forEach((v: any) => {
              if (typeof v === 'string') allTexts.push(v);
              else if (v && typeof v === 'object' && v._) allTexts.push(v._);
            });
          }
          Object.values(obj).forEach(collectText);
        }
        collectText(parsed);
      }
      const text = allTexts.join(' ').replace(/\s+/g, ' ').trim();
      return { text, status: text.length > 0 ? 'ok' : 'empty' };
    } catch {
      return { text: '', status: 'empty' };
    }
  }

  if (ext === '.ppt') {
    return {
      text: '该文件为旧版PPT二进制格式，无法自动提取文本。建议另存为PPTX格式后重新上传。',
      status: 'unsupported',
    };
  }

  if (ext === '.md' || ext === '.txt') {
    const text = buffer.toString('utf-8').replace(/^\uFEFF/, '').trim();
    return { text, status: text.length > 0 ? 'ok' : 'empty' };
  }

  return { text: '', status: 'unsupported' };
}

// ========== 主流程 ==========
async function main() {
  console.log('=== 重新处理 Materials ===\n');

  // 1. 获取所有 materials
  const recordsRes = await fetch(`${BACKEND}/api/v1/control-center/recent-records?user_id=${USER_ID}`);
  const recordsData = await recordsRes.json() as any;
  const materials = (recordsData.data || []).filter((r: any) => r.record_type === 'material');

  console.log(`共 ${materials.length} 个 materials\n`);

  // 2. 列出 test_data 中的文件
  const availableFiles = fs.readdirSync(TEST_DATA_DIR);
  console.log(`test_data 中有 ${availableFiles.length} 个文件\n`);

  // 3. 逐个处理
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const mat of materials) {
    const name: string = mat.name;
    const id: string = mat.id;
    const filePath = path.join(TEST_DATA_DIR, name);
    const ext = path.extname(name).toLowerCase();

    console.log(`\n[${materials.indexOf(mat) + 1}/${materials.length}] ${name}`);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ 文件不存在: ${filePath}`);
      // Try to find by partial name
      const match = availableFiles.find(f => f.includes(name) || name.includes(f));
      if (match) {
        console.log(`  → 找到匹配: ${match}`);
        const matchedPath = path.join(TEST_DATA_DIR, match);
        if (fs.existsSync(matchedPath)) {
          console.log(`  → 使用: ${match}`);
        }
      }
      skipped++;
      continue;
    }

    try {
      // Read file and extract text
      const buffer = fs.readFileSync(filePath);
      const { text, status } = await extractFileContent(buffer, ext);

      const textLen = text.length;
      const preview = text.slice(0, 80).replace(/[\n\r]/g, ' ');
      console.log(`  提取状态: ${status}, 长度: ${textLen}, 预览: ${preview}...`);

      // Call process-content API
      const body: any = { type: 'material', id };
      if (textLen >= 5 && status === 'ok') {
        body.file_content = text;
      }

      const procRes = await fetch(`${BACKEND}/api/v1/knowledge-builder/process-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const procData = await procRes.json() as any;
      console.log(`  API 响应: ${JSON.stringify(procData.data || procData).slice(0, 200)}`);
      success++;
    } catch (e: any) {
      console.error(`  ❌ 错误: ${e.message}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== 完成 ===`);
  console.log(`成功: ${success}, 跳过: ${skipped}, 失败: ${failed}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
