/**
 * PaperMind MVP1 数据导入脚本 (v2)
 * 修复: 文件内容读取 / BOM清理 / frontmatter跳过 / 前置数据清理
 *
 * 用法: npx tsx scripts/seed-mvp1.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

const BASE_URL = 'http://localhost:9091';
const API_PREFIX = '/api/v1';
const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

// ========== 工具函数 ==========

function apiFetch(method: string, urlPath: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_PREFIX}${urlPath}`, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json' },
    };
    if (bodyStr) options.headers!['Content-Length'] = Buffer.byteLength(bodyStr).toString();

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(fullPath, extensions));
    else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) results.push(fullPath);
  }
  return results;
}

function inferSubjectFromPath(filePath: string): string {
  const parts = path.relative(path.join(ROOT_DIR, 'test_data'), filePath).split(path.sep);
  for (const part of parts) {
    if (part.includes('数学') || part.includes('复变') || part.includes('统计') ||
        part.includes('模型') || part.includes('数值') || part.includes('代数')) return part;
  }
  return '未分类';
}

// ========== 修复2: Markdown 内容清理 ==========

/** 读取 .md 文件并清理 BOM + 跳过 frontmatter */
function readMarkdownContent(filePath: string): string {
  let raw = fs.readFileSync(filePath, 'utf-8');
  // 清理 BOM
  raw = raw.replace(/^\uFEFF/, '');
  // 跳过 YAML frontmatter (以 --- 开头和结尾的元数据块)
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) {
      raw = raw.slice(endIdx + 3).trimStart();
    }
  }
  return raw.trim();
}

// ========== 修复1: PDF 文本提取 ==========

async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text?.trim() || '';
  } catch (e: any) {
    console.log(`      ⚠️ PDF 解析失败: ${e.message?.slice(0, 60)}`);
    return '';
  }
}

async function extractPptxText(filePath: string): Promise<string> {
  try {
    const AdmZip = (await import('adm-zip')).default;
    const { parseStringPromise } = await import('xml2js');

    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const slideFiles = entries
      .filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml/i))
      .sort((a, b) => a.entryName.localeCompare(b.entryName));

    const allTexts: string[] = [];

    for (const slide of slideFiles) {
      const xml = slide.getData().toString('utf8');
      const parsed = await parseStringPromise(xml);

      // Recursively extract all <a:t> text elements from the parsed XML
      const texts: string[] = [];
      function collectText(obj: any) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(collectText); return; }
        // Handle <a:t> elements
        if (obj['a:t']) {
          const values = Array.isArray(obj['a:t']) ? obj['a:t'] : [obj['a:t']];
          values.forEach((v: any) => {
            if (typeof v === 'string') texts.push(v);
            else if (v && typeof v === 'object' && v._) texts.push(v._);
          });
        }
        // Recurse into all children
        Object.values(obj).forEach(collectText);
      }
      collectText(parsed);
      allTexts.push(...texts);
    }

    const fullText = allTexts.join(' ');
    // Clean excessive whitespace
    return fullText.replace(/\s+/g, ' ').trim();
  } catch (e: any) {
    console.log(`      ⚠️ PPTX 解析失败: ${e.message?.slice(0, 60)}`);
    return '';
  }
}

// ========== 前置数据清理 ==========

async function clearExistingData() {
  console.log('🧹 前置步骤：清理现有测试数据...');
  const supabase = (await import('@supabase/supabase-js')).createClient(
    'https://qlkucusjidkzqforlzkn.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsa3VjdXNqaWRrenFmb3JsemtuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjQ1NTI5NywiZXhwIjoyMDk4MDMxMjk3fQ.lvFxQsmP3rvSig7XXChE3ZQHy4zE8ShvEahd4TzM4O8'
  );
  const r1 = await supabase.from('study_notes').delete().eq('user_id', TEST_USER_ID);
  const r2 = await supabase.from('materials').delete().eq('user_id', TEST_USER_ID);
  console.log(`   ✅ 已清理 study_notes (${r1.error ? 'ERR' : 'OK'}), materials (${r2.error ? 'ERR' : 'OK'})\n`);
}

// ========== 主流程 ==========

interface ImportResult {
  fileName: string; id?: string; title: string;
  logicalPath?: string; papercore?: string; tags?: string[];
  aiProcessed?: boolean; status: 'imported' | 'failed' | 'processing'; error?: string;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   PaperMind MVP1 数据导入脚本 v2              ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ====== 第一步：检查服务 ======
  console.log('📡 第一步：检查后端服务...');
  const health = await apiFetch('GET', '/study-notes');
  if (health.status !== 200) { console.log(`❌ 后端异常: ${health.status}`); process.exit(1); }
  console.log('   ✅ 后端服务正常运行\n');

  // ====== 前置步骤：清理数据 ======
  await clearExistingData();

  // ====== 第二步：扫描文件 ======
  console.log('📂 第二步：扫描 test_data 目录...');
  const notesDir = path.join(ROOT_DIR, 'test_data', '学习纪要');
  const materialsDir = path.join(ROOT_DIR, 'test_data', '学习资料');
  const mdFiles = findFiles(notesDir, ['.md', '.txt']);
  const materialFiles = findFiles(materialsDir, ['.pdf', '.jpg', '.jpeg', '.png', '.ppt', '.pptx', '.doc', '.docx']);
  console.log(`   📝 学习纪要: ${mdFiles.length} 个 | 📎 学习资料: ${materialFiles.length} 个\n`);

  const results: ImportResult[] = [];

  // ====== 第三步：导入学习纪要（修复2: BOM+frontmatter+日志验证） ======
  console.log('📝 第三步：导入学习纪要...\n');

  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i];
    const fileName = path.basename(filePath);
    const title = fileName.replace(/\.(md|txt)$/i, '');
    const relPath = path.relative(ROOT_DIR, filePath);

    try {
      const content = readMarkdownContent(filePath);
      if (!content) {
        console.log(`   ⚠️  [${i + 1}/${mdFiles.length}] ${title} — 文件为空，跳过`);
        results.push({ fileName: relPath, title, status: 'failed', error: 'Empty file' });
        continue;
      }
      // 日志验证：输出前100字符
      console.log(`   📄 [${i + 1}/${mdFiles.length}] ${title}`);
      console.log(`      内容预览: ${content.slice(0, 100).replace(/\n/g, ' ')}...`);

      const createRes = await apiFetch('POST', '/study-notes', {
        title,
        content,
        blocks: [{ type: 'text' as const, content }],
        logical_path: `/${inferSubjectFromPath(filePath)}/${title}/`,
      });

      if (createRes.data?.id) {
        console.log(`      ✅ 创建成功 → ID: ${createRes.data.id.slice(0, 8)}...`);
        results.push({ fileName: relPath, id: createRes.data.id, title, status: 'processing' });
      } else {
        console.log(`      ❌ 创建失败: ${createRes.error || '未知错误'}`);
        results.push({ fileName: relPath, title, status: 'failed', error: createRes.error });
      }
    } catch (e: any) {
      console.log(`      ❌ 异常: ${e.message}`);
      results.push({ fileName: relPath, title, status: 'failed', error: e.message });
    }
  }

  // ====== 第四步：导入学习资料（修复1: 读取文件内容） ======
  console.log('\n📎 第四步：导入学习资料（读取文件内容）...\n');

  for (let i = 0; i < materialFiles.length; i++) {
    const filePath = materialFiles[i];
    const fileName = path.basename(filePath);
    const title = fileName.replace(/\.(pdf|jpg|jpeg|png|ppt|pptx|doc|docx)$/i, '');
    const ext = path.extname(fileName).toLowerCase();

    try {
      // 提取文件内容
      let fileContent = '';
      let fileNameForApi = fileName;
      if (ext === '.pdf') {
        console.log(`   📑 [${i + 1}/${materialFiles.length}] ${fileName} — 解析PDF...`);
        fileContent = await extractPdfText(filePath);
        console.log(`      PDF文本: ${fileContent.length} 字符, 预览: ${fileContent.slice(0, 80).replace(/\n/g, ' ')}...`);
      } else if (ext === '.pptx') {
        console.log(`   📊 [${i + 1}/${materialFiles.length}] ${fileName} — 解析PPTX...`);
        fileContent = await extractPptxText(filePath);
        console.log(`      PPTX文本: ${fileContent.length} 字符, 预览: ${fileContent.slice(0, 80).replace(/\n/g, ' ')}...`);
      } else if (ext === '.ppt') {
        console.log(`   📊 [${i + 1}/${materialFiles.length}] ${fileName} — 旧版PPT格式，无法提取...`);
        fileContent = `[旧版PPT二进制格式，无法自动提取文本。建议另存为PPTX格式后重新上传。文件名: ${fileName}]`;
        console.log(`      ⚠️ 旧版.ppt不支持文本提取`);
      } else if (ext === '.md' || ext === '.txt') {
        fileContent = readMarkdownContent(filePath);
        console.log(`   📄 [${i + 1}/${materialFiles.length}] ${fileName} — 文本预览: ${fileContent.slice(0, 80).replace(/\n/g, ' ')}...`);
      } else {
        // 图片等无法提取的
        fileContent = `[${ext.toUpperCase()} 文件，需OCR: ${fileName}]`;
        console.log(`   🖼️  [${i + 1}/${materialFiles.length}] ${fileName} — 无法提取文本 (${ext})`);
      }

      // 创建资料记录
      const createRes = await apiFetch('POST', '/materials', {
        name: fileName,
        file_name: fileName,
        logical_path: '/学习资料/',
      });

      if (createRes.data?.id) {
        console.log(`      ✅ 创建成功 → ID: ${createRes.data.id.slice(0, 8)}...`);

        // 触发 AI 处理，传入 file_content
        if (fileContent && fileContent.trim().length >= 5) {
          try {
            const procRes = await apiFetch('POST', '/knowledge-builder/process-content', {
              type: 'material',
              id: createRes.data.id,
              file_content: fileContent,
            });
            console.log(`      🤖 AI处理已触发 → ${procRes.data?.status || 'submitted'}`);
          } catch {
            console.log(`      ⚠️ AI触发失败`);
          }
        } else {
          console.log(`      ⚠️ 内容不足，跳过AI处理`);
        }

        results.push({ fileName: `test_data/学习资料/${fileName}`, id: createRes.data.id, title, status: 'processing' });
      } else {
        console.log(`      ❌ 创建失败: ${createRes.error || '未知错误'}`);
        results.push({ fileName, title, status: 'failed', error: createRes.error });
      }
    } catch (e: any) {
      console.log(`      ❌ 异常: ${e.message}`);
      results.push({ fileName, title, status: 'failed', error: e.message });
    }
  }

  // ====== 第五步：AI 处理学习纪要（异步触发） ======
  console.log('\n🤖 第五步：触发学习纪要 AI 处理...\n');

  const noteResults = results.filter(r => results.indexOf(r) < mdFiles.length && r.status === 'processing');
  for (const nr of noteResults) {
    if (!nr.id) continue;
    try {
      const pr = await apiFetch('POST', '/knowledge-builder/process-content', {
        type: 'study_note', id: nr.id,
      });
      if (pr.data?.status) console.log(`   ✅ ${nr.title.slice(0, 30)} → ${pr.data.status}`);
      else console.log(`   ⚠️ ${nr.title.slice(0, 30)} → ${pr.error || '未知'}`);
    } catch { console.log(`   ⚠️ ${nr.title.slice(0, 30)} → 触发失败`); }
  }

  // ====== 第六步：等待 AI 处理完成 ======
  console.log('\n⏳ 第六步：等待 AI 处理完成...\n');

  const pendingResults = results.filter(r => r.status === 'processing');
  for (let round = 0; round < 8; round++) {
    await sleep(15000);
    let pending = 0;

    try {
      const [notesRes, materialsRes] = await Promise.all([
        apiFetch('GET', '/study-notes'),
        apiFetch('GET', '/materials'),
      ]);
      const allRecords: any[] = [
        ...(notesRes.data || []).map((r: any) => ({ ...r, table: 'study_note' })),
        ...(materialsRes.data || []).map((r: any) => ({ ...r, table: 'material' })),
      ];
      const recordMap = new Map<string, any>();
      allRecords.forEach(r => recordMap.set(r.id, r));

      for (const r of pendingResults) {
        const record = r.id ? recordMap.get(r.id) : null;
        if (record?.ai_processed) {
          r.aiProcessed = true;
          r.logicalPath = record.logical_path;
          r.papercore = record.papercore;
          r.tags = record.tags;
          r.status = 'imported';
        } else { pending++; }
      }
    } catch { /* retry next round */ }

    const done = pendingResults.filter(r => r.aiProcessed).length;
    console.log(`   轮次 ${round + 1}/8: ✅ ${done}/${pendingResults.length} 已完成, ⏳ ${pending} 待处理`);
    if (pending === 0) break;
  }

  // ====== 第七步：获取图谱数据 ======
  console.log('\n🗺️  第七步：获取知识图谱数据...');
  let graphData: any = null;
  try {
    const gres = await apiFetch('GET', '/knowledge-builder/graph-data');
    graphData = gres.data;
    console.log(`   ✅ 节点: ${graphData?.nodes?.length || 0} | 边: ${graphData?.edges?.length || 0} | 领域圈: ${graphData?.domains?.length || 0}`);
  } catch {}

  // ====== 第八步：红点检查 ======
  console.log('\n🔴 第八步：控制中心红点检查...');
  try {
    const [nr, mr] = await Promise.all([apiFetch('GET', '/study-notes'), apiFetch('GET', '/materials')]);
    const redDots = [...(nr.data||[]), ...(mr.data||[])].filter((r: any) => r.ai_processed && !r.viewed_after_process).length;
    console.log(`   ✅ 红点数: ${redDots}`);
  } catch {}

  // ====== 第九步：生成报告 ======
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   📋 MVP1 测试报告 (v2)                      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const processedNotes = results.filter(r => results.indexOf(r) < mdFiles.length && r.aiProcessed);
  const processedMats = results.filter(r => results.indexOf(r) >= mdFiles.length && r.aiProcessed);

  console.log(`| 指标 | 数值 |`);
  console.log(`|------|------|`);
  console.log(`| ✅ 纪要导入 | ${processedNotes.length} / ${mdFiles.length} |`);
  console.log(`| ✅ 资料导入 | ${processedMats.length} / ${materialFiles.length} |`);
  console.log(`| 🤖 AI处理完成 | ${results.filter(r => r.aiProcessed).length} |`);
  console.log(`| 🗺️ 图谱节点 | ${graphData?.nodes?.length || 0} |`);
  console.log(`| 🔗 图谱边 | ${graphData?.edges?.length || 0} |`);
  console.log(`| 🌐 领域圈 | ${graphData?.domains?.length || 0} |`);

  // 文件夹层级
  const paths = new Set<string>();
  results.filter(r => r.logicalPath).forEach(r => paths.add(r.logicalPath!));
  console.log(`\n📂 文件夹层级 (${paths.size}):`);
  Array.from(paths).sort().slice(0, 20).forEach(p => console.log(`   ${p}`));

  // 摘要表
  console.log(`\n📝 记录摘要:\n`);
  console.log(`| # | 名称 | 路径 | 摘要 | 标签 |`);
  console.log(`|---|------|------|------|------|`);
  results.filter(r => r.aiProcessed).slice(0, 25).forEach((r, i) => {
    const pc = (r.papercore || '').slice(0, 35) + ((r.papercore?.length || 0) > 35 ? '...' : '');
    const lp = (r.logicalPath || '').slice(0, 25);
    const tg = (r.tags || []).slice(0, 2).join(',');
    console.log(`| ${i+1} | ${r.title.slice(0,12)} | ${lp} | ${pc} | ${tg} |`);
  });

  const totalOK = results.filter(r => r.aiProcessed).length;
  const totalFail = results.filter(r => r.status === 'failed').length;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`总计: ${totalOK} AI处理完成, ${totalFail} 失败, ${results.length} 总文件`);
  console.log(`${'─'.repeat(50)}\n`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
