import { Router } from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { anthropic, DEFAULT_MODEL } from '../config/ai.js';

const router = Router();

// ==========================================
// Helper: Extract existing hierarchical tags for a user
// ==========================================
async function getExistingTagHierarchy(userId: string): Promise<{
  L1: string[];
  L2: string[];
  L3: string[];
}> {
  const supabase = getSupabaseClient();

  const [notesRes, materialsRes] = await Promise.all([
    supabase.from('study_notes').select('tags').eq('user_id', userId).not('tags', 'is', null),
    supabase.from('materials').select('tags').eq('user_id', userId).not('tags', 'is', null),
  ]);

  const allTags: string[][] = [];
  (notesRes.data || []).forEach((r: any) => {
    if (Array.isArray(r.tags)) allTags.push(r.tags);
  });
  (materialsRes.data || []).forEach((r: any) => {
    if (Array.isArray(r.tags)) allTags.push(r.tags);
  });

  // Extract L1/L2/L3 from hierarchical tags (format: [L1, L2, L3] arrays)
  const L1 = new Set<string>();
  const L2 = new Set<string>();
  const L3 = new Set<string>();

  allTags.forEach(tagArr => {
    // Format: [L1, L2, ...L3s]
    if (tagArr.length >= 1 && tagArr[0]) L1.add(tagArr[0]);
    if (tagArr.length >= 2 && tagArr[1]) L2.add(tagArr[1]);
    for (let i = 2; i < tagArr.length; i++) {
      if (tagArr[i]) L3.add(tagArr[i]);
    }
  });

  return {
    L1: Array.from(L1),
    L2: Array.from(L2),
    L3: Array.from(L3),
  };
}

// ==========================================
// Helper: Extract text content from a record
// ==========================================
function extractText(record: any): string {
  if (record.content) return record.content;
  if (record.title) return record.title;
  if (record.name) return record.name;
  if (record.description) return record.description;
  return '';
}

// ==========================================
// Helper: Extract text from file buffers (PDF, PPTX)
// ==========================================
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
    } catch {
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

// ==========================================
// Helper: Strip TOC (table of contents) from extracted PDF text
// TOC pages have dense dot leaders and page numbers but no real content
// ==========================================
function stripTOC(text: string): string {
  if (!text || text.length < 2000) return text;

  // Check if beginning looks like a TOC (high dot density from dot leaders)
  const firstChunk = text.slice(0, 2000);
  const dotRatio = (firstChunk.match(/\./g) || []).length / firstChunk.length;

  if (dotRatio > 0.05) {
    // This is likely a TOC. Find page markers and skip past TOC pages.
    const markerRegex = /-{1,3}\s*\d+\s*of\s*\d+\s*-{1,3}/g;
    const markers: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = markerRegex.exec(text)) !== null) {
      markers.push(m.index + m[0].length);
    }

    if (markers.length >= 3) {
      // Skip past the 3rd page marker (pages 1-2 are usually TOC)
      const skipTo = markers[2];
      if (skipTo > 500 && skipTo < text.length - 100) {
        const trimmed = text.slice(skipTo).trim();
        console.log(`[stripTOC] dot density ${(dotRatio*100).toFixed(1)}%, skipped ${skipTo} chars to page marker 3, remaining: ${trimmed.length}`);
        return trimmed;
      }
    }

    // Fallback: skip first 3000 chars (roughly 1-2 pages of TOC)
    if (text.length > 4000) {
      const trimmed = text.slice(3000).trim();
      console.log(`[stripTOC] dot density ${(dotRatio*100).toFixed(1)}%, skip-first-3000 fallback, remaining: ${trimmed.length}`);
      return trimmed;
    }
  }

  return text;
}

// Helper: Check text readability (filter garbled content)
// ==========================================
function isReadableText(text: string): boolean {
  if (!text || text.length < 5) return false;

  // Count CJK characters specifically (for Chinese academic content)
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  const cjkRatio = (cjk || []).length / text.length;

  // If text has virtually no CJK characters, it's likely garbled PDF output
  // (garbled PDFs produce random bytes, digits, whitespace but no real Chinese text)
  if (cjkRatio < 0.03) {
    // Allow pure-English documents (even lower ASCII threshold for formula-heavy content)
    const asciiLetters = text.match(/[a-zA-Z]/g);
    const asciiRatio = (asciiLetters || []).length / text.length;
    if (asciiRatio < 0.15) return false;
  }

  // Count overall readable characters (CJK, ASCII letters, digits, common punctuation)
  const readable = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9\s.,;:!?()\[\]{}\-+=_"'<>/\\@#$%^&*]/g);
  if (!readable) return false;
  return readable.length / text.length > 0.15;
}


// ==========================================
// Helper: Build L1→L2 tree from DB records (real-time, for LLM global positioning)
// ==========================================
async function buildL1L2Tree(userId: string): Promise<Map<string, Set<string>>> {
  const supabase = getSupabaseClient();
  const [notesRes, materialsRes] = await Promise.all([
    supabase.from('study_notes').select('tags').eq('user_id', userId).not('tags', 'is', null),
    supabase.from('materials').select('tags').eq('user_id', userId).not('tags', 'is', null),
  ]);

  const tree = new Map<string, Set<string>>();
  for (const r of [...(notesRes.data || []), ...(materialsRes.data || [])]) {
    const tags: string[] = r.tags || [];
    if (tags.length >= 2 && tags[0] && tags[1]) {
      if (!tree.has(tags[0])) tree.set(tags[0], new Set());
      tree.get(tags[0])!.add(tags[1]);
    }
  }
  return tree;
}

function formatL1L2Tree(tree: Map<string, Set<string>>): string {
  if (tree.size === 0) return '';
  const lines: string[] = [];
  for (const [l1, l2s] of tree) {
    lines.push(`  ${l1}`);
    for (const l2 of l2s) {
      lines.push(`    └─ ${l2}`);
    }
  }
  return lines.join('\n');
}

// ==========================================
// Helper: Get top-K existing L3s under a given L1/L2, scored by keyword overlap with papercore
// (no embedding model — simple character overlap)
// ==========================================
async function getTopL3sUnderL2(
  userId: string,
  l1: string,
  l2: string,
  papercore: string,
  topK: number
): Promise<{ name: string; papercore: string }[]> {
  const supabase = getSupabaseClient();
  const [notesRes, materialsRes] = await Promise.all([
    supabase.from('study_notes').select('tags, papercore').eq('user_id', userId).not('tags', 'is', null),
    supabase.from('materials').select('tags, papercore').eq('user_id', userId).not('tags', 'is', null),
  ]);

  const l3Set = new Map<string, string>(); // l3_name → papercore
  for (const r of [...(notesRes.data || []), ...(materialsRes.data || [])]) {
    const tags: string[] = r.tags || [];
    if (tags.length >= 3 && tags[0] === l1 && tags[1] === l2) {
      for (let i = 2; i < tags.length; i++) {
        if (tags[i] && !l3Set.has(tags[i])) {
          l3Set.set(tags[i], r.papercore || '');
        }
      }
    }
  }

  // Score by character overlap with papercore
  const papercoreChars = new Set(papercore.replace(/\s+/g, ''));
  const scored = Array.from(l3Set.entries()).map(([name, pc]) => {
    let overlap = 0;
    for (const ch of name) { if (papercoreChars.has(ch)) overlap++; }
    for (const ch of (pc || '').replace(/\s+/g, '')) { if (papercoreChars.has(ch)) overlap++; }
    return { name, papercore: pc, score: overlap };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ name, papercore }) => ({ name, papercore: papercore.slice(0, 200) }));
}

// ==========================================
// Helper: Count total L3 tags under a given L1/L2
// ==========================================
async function countL3sUnderL2(userId: string, l1: string, l2: string): Promise<number> {
  const supabase = getSupabaseClient();
  const [notesRes, materialsRes] = await Promise.all([
    supabase.from('study_notes').select('tags').eq('user_id', userId).not('tags', 'is', null),
    supabase.from('materials').select('tags').eq('user_id', userId).not('tags', 'is', null),
  ]);

  const l3Set = new Set<string>();
  for (const r of [...(notesRes.data || []), ...(materialsRes.data || [])]) {
    const tags: string[] = r.tags || [];
    if (tags.length >= 3 && tags[0] === l1 && tags[1] === l2) {
      for (let i = 2; i < tags.length; i++) {
        if (tags[i]) l3Set.add(tags[i]);
      }
    }
  }
  return l3Set.size;
}

// ==========================================
// NEW PIPELINE: LLM-only strategy (no embedding)
//   1. Generate papercore from raw text (unchanged)
//   2. Global positioning: LLM reads papercore + live L1→L2 tree → decides L1/L2
//   3. Local evolution: LLM reads papercore + top-8 existing L3s under L2 → decides L3 tags
// Each document has exactly ONE L1 and ONE L2.
// ==========================================

// ==========================================
// Step 1: Generate papercore (standalone, no tags needed beforehand)
// ==========================================
async function generatePapercore(
  text: string,
  opts?: { fileName?: string; folderName?: string }
): Promise<string> {
  if (!text || text.trim().length < 10) {
    // Degraded: no text at all
    return buildDegradedPapercore(opts?.fileName, opts?.folderName);
  }

  let sampleText: string;
  if (text.length > 6000) {
    const third = Math.floor(text.length / 3);
    sampleText = `[开头]\n${text.slice(0, 1200)}\n\n[中段]\n${text.slice(third, third + 800)}\n\n[末尾]\n${text.slice(-800)}`;
  } else {
    sampleText = text.slice(0, 2000);
  }

  const prompt = `你是学术摘要撰写专家。请为以下文档撰写学术摘要（Papercore）。

要求：
1. 第一行输出文档的一级标题/总标题（直接提取原文，不要改写）
2. 正文以二级标题为线索组织叙述，保持逻辑连贯
3. 涵盖核心定义、公式定理、关键结论
4. 80-150字，语言简洁专业
5. 只输出摘要文本，不要加任何前缀标记

文档内容：${sampleText}`;

  try {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 400,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.content
      .filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
    return content || text.slice(0, 150);
  } catch (e) {
    console.error('[papercore] LLM error:', e);
    return text.slice(0, 150);
  }
}

/**
 * 降级 Papercore：当文档可读文本不足（<30% 或公式/图表密集型）时，
 * 根据文件名和上下文推断主题描述
 */
function buildDegradedPapercore(fileName?: string, folderName?: string): string {
  const source = fileName || folderName;
  if (source) {
    const keyword = source.replace(/\.[^.]+$/, '').replace(/[_\-]/g, ' ').trim();
    return `该文档以公式/图表为主，根据文件名及上下文推断，核心内容定位为：${keyword}。`;
  }
  return '该文档以公式/图表为主，核心主题未识别，建议手动补充摘要。';
}

// ==========================================
// Helper: Character-overlap ratio between two Chinese strings
// Returns 0–1, where 1 = same char set. Used to force-match LLM L3 outputs
// against existing L3 tags (prevents L3 tag explosion).
// ==========================================
function charOverlapRatio(a: string, b: string): number {
  const aChars = a.replace(/\s+/g, '');
  const bChars = b.replace(/\s+/g, '');
  if (!aChars || !bChars) return 0;
  const aSet = new Set(aChars);
  const bSet = new Set(bChars);
  let shared = 0;
  for (const ch of aSet) { if (bSet.has(ch)) shared++; }
  return shared / Math.min(aSet.size, bSet.size);
}

// ==========================================
// Helper: Get ALL existing L3 tag names under a given L1/L2
// ==========================================
async function getAllL3NamesUnderL2(userId: string, l1: string, l2: string): Promise<string[]> {
  const supabase = getSupabaseClient();
  const [notesRes, materialsRes] = await Promise.all([
    supabase.from('study_notes').select('tags').eq('user_id', userId).not('tags', 'is', null),
    supabase.from('materials').select('tags').eq('user_id', userId).not('tags', 'is', null),
  ]);
  const l3Set = new Set<string>();
  for (const r of [...(notesRes.data || []), ...(materialsRes.data || [])]) {
    const tags: string[] = r.tags || [];
    if (tags.length >= 3 && tags[0] === l1 && tags[1] === l2) {
      for (let i = 2; i < tags.length; i++) {
        if (tags[i]) l3Set.add(tags[i]);
      }
    }
  }
  return Array.from(l3Set);
}

// ==========================================
// Call 2+3: Global positioning (L1/L2) + Local evolution (L3)
// ==========================================
async function generateHierarchicalTags(
  papercore: string,
  textLength: number,
  existingHierarchy: { L1: string[]; L2: string[]; L3: string[] },
  userId: string
): Promise<{ L1: string; L2: string; l2IsNew: boolean; tags: string[] }> {
  const INVALID = new Set(['无','未知','未分类','无法识别','无法确定','无法分类','其他','其它','未标注']);

  // L3 new-tag limit: <3000 chars → ≤3, <6000 → ≤4, ≥6000 → ≤5
  const l3NewLimit = textLength < 3000 ? 3 : textLength < 6000 ? 4 : 5;

  let l1 = '';
  let l2 = '';
  let l2IsNew = false;

  // ==========================================
  // Call 2: 全局定位 — 确定 L1/L2
  // ==========================================
  const l1L2Tree = await buildL1L2Tree(userId);
  const treeText = formatL1L2Tree(l1L2Tree);

  const globalPrompt = `你是学科分类专家。请将以下文档归类到学科树中。

现有学科树：
${treeText || '(空 — 首次分类，需新建)'}

文档摘要：
${papercore.slice(0, 800)}

规则：
1. 精确匹配：如果文档核心内容与某个已有L2高度吻合（该L2的核心课程内容），使用该L2名称（必须与学科树中完全一致）
2. 模糊匹配判别：如果文档核心内容与所有已有L2的核心方向都只是"有数学关联"但实质学科不同（如：线性规划/优化理论 ≠ 概率论、数据挖掘 ≠ 复分析），则应新建L2，不必勉强归类
3. 新建L2命名：选择该学科的正式中文课程/学科名称（如："最优化方法"、"运筹学"、"数值分析"、"统计学"等），避免泛化命名
4. L1命名规则：一级学科名称（如：数学、物理、化学、计算机科学）；如果现有L1都不匹配且无法归类，可建新L1
5. 判断优先级：学科本质匹配 > 表面关键词匹配。不要因为文档中出现了某个学科术语就将整个文档归入该学科

输出JSON（不要markdown代码块）：{"L1":"一级学科", "L2":"二级学科", "reasoning":"简要判断理由"}`;

  try {
    const resp = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 256,
      temperature: 0.3,
      messages: [{ role: 'user', content: globalPrompt }],
    });
    const c = resp.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('').trim();
    const m = c.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      l1 = (parsed.L1 || '').trim();
      l2 = (parsed.L2 || '').trim();
      const reasoning = parsed.reasoning || '';
      console.log(`[global-position] L1="${l1}" L2="${l2}" | ${reasoning}`);
    }
  } catch (e) {
    console.error('[global-position] LLM error:', e);
  }

  if (INVALID.has(l1)) l1 = '';
  if (INVALID.has(l2)) l2 = '';

  // Determine if L2 is new
  if (l2 && existingHierarchy.L2.length > 0 && !existingHierarchy.L2.includes(l2)) {
    l2IsNew = true;
    console.log(`[global-position] L2="${l2}" is NEW`);
  }

  // L1 guard: if existing L1s exist, must match one exactly
  if (l1 && existingHierarchy.L1.length > 0 && !existingHierarchy.L1.includes(l1)) {
    console.log(`[global-position] L1="${l1}" not in existing list [${existingHierarchy.L1.join(', ')}], falling back to first`);
    l1 = existingHierarchy.L1[0];
  }

  // ==========================================
  // Call 3: 局部演化 — 确定 L3 标签
  // ==========================================
  let finalL3s: string[] = [];

  if (l1 && l2) {
    const [topL3s, l2TotalL3] = await Promise.all([
      getTopL3sUnderL2(userId, l1, l2, papercore, 8),
      countL3sUnderL2(userId, l1, l2),
    ]);

    const maxTotal = l2TotalL3 + l3NewLimit;
    const topL3Text = topL3s.length > 0
      ? topL3s.map((t, i) => `${i + 1}. "${t.name}"\n   摘要：${t.papercore.slice(0, 150)}`).join('\n')
      : '(该学科下暂无已有标签)';

    const l3Prompt = `你是章节标签管理专家。请从新文档提取章节标题（L3标签）。

学科路径：${l1} > ${l2}
该学科下当前共 ${l2TotalL3} 个标签。

与新文档最相关的已有标签（必须优先复用）：

${topL3Text}

───

新文档摘要：
${papercore.slice(0, 600)}

规则：
1. 提取文档中的章节/主题标题作为L3 tag
2. 强制复用：如果文档章节与上述已有标签内容相同或高度相似，必须输出已有标签名称（逐字一致），不准改写
3. 每个章节用一个标签，不要把小节拆成独立标签——大章节内的小节归入大章节标签
4. 新增标签不超过 ${l3NewLimit} 个（文档短则更少）
5. 按文档出现顺序排列

输出JSON数组（不要markdown代码块）：["tag1", "tag2", ...]`;

    try {
      const resp = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 512,
        temperature: 0.3,
        messages: [{ role: 'user', content: l3Prompt }],
      });
      const c = resp.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('').trim();
      const m = c.match(/\[[\s\S]*\]/);
      if (m) {
        const proposed = JSON.parse(m[0]).filter(Boolean);
        // === Post-process: force-match against existing L3s via char overlap ===
        const allExistingL3s = await getAllL3NamesUnderL2(userId, l1, l2);
        const matchedL3s: string[] = [];
        const unmatchedL3s: string[] = [];

        for (const tag of proposed) {
          let bestMatch = '';
          let bestScore = 0;
          for (const ex of allExistingL3s) {
            const score = charOverlapRatio(tag, ex);
            if (score > 0.75 && score > bestScore) {
              bestMatch = ex;
              bestScore = score;
            }
          }
          if (bestMatch) {
            if (!matchedL3s.includes(bestMatch)) {
              matchedL3s.push(bestMatch);
              console.log(`  [l3-force-match] "${tag}" → "${bestMatch}" (overlap ${(bestScore*100).toFixed(0)}%)`);
            }
          } else {
            unmatchedL3s.push(tag);
          }
        }

        // Enforce new-tag limit: only l3NewLimit truly-new tags, rest discarded
        const allowedNew = unmatchedL3s.slice(0, l3NewLimit);
        finalL3s = [...matchedL3s, ...allowedNew];
        if (unmatchedL3s.length > l3NewLimit) {
          console.log(`  [l3-limit] ${unmatchedL3s.length - l3NewLimit} excess new tags dropped: ${unmatchedL3s.slice(l3NewLimit).join(', ')}`);
        }

        console.log(`[l3-evolution] ${l1}/${l2}: ${allExistingL3s.length} existing → ${allExistingL3s.length + allowedNew.length - matchedL3s.filter(t => !allExistingL3s.includes(t)).length} after (limit ${l2TotalL3 + l3NewLimit})`);
      }
    } catch (e) {
      console.error('[l3-evolution] LLM error:', e);
    }
  }

  // Filter invalid
  const filteredL3s = finalL3s.filter(t => !INVALID.has(t) && !t.startsWith('无法') && !t.startsWith('未'));

  console.log(`[tags-result] L1="${l1}" L2="${l2}" l2IsNew=${l2IsNew} L3=[${filteredL3s.join(', ')}]`);
  return { L1: l1, L2: l2, l2IsNew, tags: filteredL3s };
}

// Build DB-safe payload
async function safePayload(base: Record<string, any>): Promise<Record<string, any>> {
  return { ...base };
}

/**
 * 生成多 L3 的逻辑路径数组
 * 每个 L3 独立生成一条路径
 */
function buildLogicalPaths(L1: string, L2: string, knowledgePoints: string[]): string[] {
  if (L1 && L2) {
    if (knowledgePoints.length > 0) {
      return knowledgePoints.map(l3 => `/${L1}/${L2}/${l3}/`);
    }
    return [`/${L1}/${L2}/`];
  }
  if (L1) return [`/${L1}/`];
  return ['/未分类/'];
}

// ==========================================
// POST /process-content - Process a single record
// ==========================================

// Helper: Read material file content from disk (for uploaded materials)
async function readMaterialFileFromDisk(material: any): Promise<string> {
  try {
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const testDataDir = path.resolve(process.cwd(), '..', 'test_data', '学习资料');
    let filePath: string | null = null;

    // Try file_path → uploads directory (materials table uses file_path not file_url)
    const storedPath = material.file_path || material.file_url;
    if (storedPath) {
      const urlPath = storedPath.replace(/^\/uploads\//, '');
      const candidate = path.join(uploadsDir, urlPath);
      if (fs.existsSync(candidate)) filePath = candidate;
    }

    // Try name → test_data directory (name stores original filename)
    if (!filePath && material.name) {
      const candidate = path.join(testDataDir, material.name);
      if (fs.existsSync(candidate)) filePath = candidate;
    }

    if (!filePath) return '';

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.csv': 'text/plain',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    // Use dynamic import for extractText to avoid circular dependency issues
    const { extractText: extText } = await import('../utils/extract-text.js');
    const result = await extText(filePath, mimeType, path.basename(filePath));
    return result.text || '';
  } catch (e) {
    console.error('[readMaterialFileFromDisk] Error:', e);
    return '';
  }
}

router.post('/process-content', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { type, id, file_content } = req.body;

    if (!type || !id) {
      return res.status(400).json({ error: 'type and id are required' });
    }

    if (type !== 'study_note' && type !== 'material') {
      return res.status(400).json({ error: 'type must be "study_note" or "material"' });
    }

    const table = type === 'study_note' ? 'study_notes' : 'materials';
    const supabase = getSupabaseClient();

    // Fetch the record
    const { data: record, error: fetchError } = await supabase
      .from(table)
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    // Extract text: use file_content if provided (for materials with actual file content),
    // otherwise fall back to extracting from the DB record
    // For materials without file_content, try reading file from disk
    let dbExtractedText = extractText(record);
    let text: string;

    if (file_content && file_content.trim().length >= 5) {
      text = stripTOC(file_content);
    } else if (type === 'material') {
      // For materials without file_content, always try reading from disk first
      // (DB record only has filename, not useful for AI)
      const diskText = await readMaterialFileFromDisk(record);
      if (diskText && diskText.trim().length >= 5) {
        text = stripTOC(diskText);
        console.log(`[process-content] Read ${text.length} chars from disk for material ${id}`);
      } else {
        text = dbExtractedText;
      }
    } else {
      text = dbExtractedText;
    }

    // Detect unsupported/placeholder content
    const isPlaceholder = text.startsWith('[') && (text.includes('需OCR') || text.includes('旧版PPT') || text.includes('无法自动提取'));
    const isUnsupported = text.includes('旧版PPT二进制格式');

    if (!text || text.trim().length < 5 || isPlaceholder) {
      const fallbackPapercore = isUnsupported
        ? '该文件为旧版PPT格式，无法提取文本。请手动补充学习心得或转为PPTX格式后重新上传。'
        : (isPlaceholder ? text : '');
      await supabase.from(table).update({
        ai_processed: true,
        papercore: fallbackPapercore,
        logical_path: '/未分类/',
      }).eq('id', id).eq('user_id', userId);
      return res.json({ data: { id, status: 'skipped', reason: isUnsupported ? 'unsupported_ppt' : 'insufficient content' } });
    }

    // 提取文件名用于降级 Papercore
    const recordFileName = (record as any).name || (record as any).title || (record as any).file_name || undefined;

    // Check text readability (filter garbled PDF content)
    if (!isReadableText(text)) {
      const degradedPapercore = buildDegradedPapercore(recordFileName);
      await supabase.from(table).update({
        ai_processed: true,
        papercore: degradedPapercore,
        logical_path: JSON.stringify(['/未分类/']),
      }).eq('id', id).eq('user_id', userId);
      return res.json({ data: { id, status: 'processed', papercore: degradedPapercore, reason: 'degraded' } });
    }

    // Get existing tag hierarchy
    const existingHierarchy = await getExistingTagHierarchy(userId);
    
    // Step 1: Generate papercore (standalone, no tags needed)
    const papercore = await generatePapercore(text, { fileName: recordFileName });

    // Step 2: Global positioning + local evolution → determine L1/L2/L3
    const result = await generateHierarchicalTags(papercore, text.length, existingHierarchy, userId);

    const { L1, L2, tags: knowledgePoints } = result;
    const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
    const logicalPath = JSON.stringify(logicalPaths);
    const hierarchicalTags = [L1, L2, ...knowledgePoints].filter(Boolean);

    // Update the record
    const updatePayload = {
      tags: hierarchicalTags,
      papercore,
      logical_path: logicalPath,
      ai_processed: true,
      viewed_after_process: false,
      updated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from(table)
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', userId);

    if (updateError) throw new Error(updateError.message);

    res.json({
      data: {
        id,
        tags: hierarchicalTags,
        papercore,
        logical_path: logicalPaths,
        status: 'processed',
      },
    });
  } catch (err: any) {
    console.error('process-content error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// POST /reprocess-material - Reprocess a single material from disk
// ==========================================
router.post('/reprocess-material', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const supabase = getSupabaseClient();

    // 1. Get material
    const { data: material, error: fetchError } = await supabase
      .from('materials')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !material) {
      return res.status(404).json({ error: 'Material not found' });
    }

    // 2. Find file on disk
    let filePath: string | null = null;
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const testDataDir = path.resolve(process.cwd(), '..', 'test_data', '学习资料');

    const storedPath = material.file_path || material.file_url;
    if (storedPath) {
      const urlPath = storedPath.replace(/^\/uploads\//, '');
      const candidate = path.join(uploadsDir, urlPath);
      if (fs.existsSync(candidate)) filePath = candidate;
    }

    if (!filePath && material.name) {
      const candidate = path.join(testDataDir, material.name);
      if (fs.existsSync(candidate)) filePath = candidate;
    }

    if (!filePath) {
      // Try fuzzy match
      const searchName = material.name;
      if (searchName) {
        try {
          const files = fs.readdirSync(testDataDir);
          const match = files.find(f => f.includes(searchName) || searchName.includes(f));
          if (match) filePath = path.join(testDataDir, match);
        } catch {}
      }
    }

    if (!filePath) {
      return res.status(404).json({ error: 'File not found on disk', name: material.name });
    }

    // 3. Extract text from file
    const ext = path.extname(filePath).toLowerCase();
    const buffer = fs.readFileSync(filePath);
    let fileContent = '';

    if (ext === '.pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        fileContent = (result.text || '').trim();
      } catch {}
    } else if (ext === '.pptx') {
      try {
        const AdmZip = (await import('adm-zip')).default;
        const { parseStringPromise } = await import('xml2js');
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        const slideFiles = entries
          .filter((e: any) => e.entryName.match(/ppt\/slides\/slide\d+\.xml/i))
          .sort((a: any, b: any) => a.entryName.localeCompare(b.entryName));
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
        fileContent = allTexts.join(' ').replace(/\s+/g, ' ').trim();
      } catch {}
    } else if (ext === '.md' || ext === '.txt') {
      fileContent = buffer.toString('utf-8').replace(/^\uFEFF/, '').trim();
    }

    console.log(`[reprocess-material] ${material.name}: extracted ${fileContent.length} chars`);

    // Strip TOC (table of contents) to get real content
    fileContent = stripTOC(fileContent);
    console.log(`[reprocess-material] ${material.name}: after TOC strip ${fileContent.length} chars`);

    // 4. Check readability
    if (!fileContent || fileContent.length < 5) {
      return res.json({ data: { id, status: 'skipped', reason: 'no content extracted' } });
    }

    const materialFileName = material.name || undefined;

    if (!isReadableText(fileContent)) {
      const degradedPapercore = buildDegradedPapercore(materialFileName);
      await supabase.from('materials').update({
        ai_processed: true,
        papercore: degradedPapercore,
        logical_path: JSON.stringify(['/未分类/']),
      }).eq('id', id).eq('user_id', userId);
      return res.json({ data: { id, status: 'processed', papercore: degradedPapercore, reason: 'degraded' } });
    }

    // 5. Generate papercore first, then tags from papercore
    const existingHierarchy = await getExistingTagHierarchy(userId);
        const papercore = await generatePapercore(fileContent, { fileName: materialFileName });
    const result = await generateHierarchicalTags(papercore, fileContent.length, existingHierarchy, userId);

    const { L1, L2, tags: knowledgePoints } = result;
    const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
    const logicalPath = JSON.stringify(logicalPaths);
    const hierarchicalTags = [L1, L2, ...knowledgePoints].filter(Boolean);

    // 6. Update
    const updatePayload = {
      tags: hierarchicalTags,
      papercore,
      logical_path: logicalPath,
      ai_processed: true,
      viewed_after_process: false,
      updated_at: new Date().toISOString(),
    };
    const { error: updateError } = await supabase.from('materials').update(updatePayload).eq('id', id).eq('user_id', userId);
    if (updateError) throw new Error(updateError.message);

    res.json({
      data: {
        id,
        tags: hierarchicalTags,
        papercore,
        logical_path: logicalPaths,
        status: 'reprocessed',
      },
    });
  } catch (err: any) {
    console.error('reprocess-material error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// POST /process-study-notes (batch, backward compat)
// ==========================================
router.post('/process-study-notes', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();

    const { data: unprocessed, error: fetchError } = await supabase
      .from('study_notes')
      .select('*')
      .eq('ai_processed', false)
      .order('created_at', { ascending: false })
      .limit(10);

    if (fetchError) throw fetchError;
    if (!unprocessed || unprocessed.length === 0) {
      return res.json({ data: [], message: 'No unprocessed study notes' });
    }

    const results = [];
    for (const note of unprocessed) {
      try {
        const userId = note.user_id || 'guest';
        const text = extractText(note);

        if (text.trim().length < 5) {
          await supabase.from('study_notes').update({
            ai_processed: true,
            papercore: text || '',
            logical_path: '/未分类/',
          }).eq('id', note.id);
          results.push({ id: note.id, status: 'skipped' });
          continue;
        }

        const existingHierarchy = await getExistingTagHierarchy(userId);
                const noteFileName = (note as any).title || undefined;
        const papercore = await generatePapercore(text, { fileName: noteFileName });
        const result = await generateHierarchicalTags(papercore, text.length, existingHierarchy, userId);

        const { L1, L2, tags: knowledgePoints } = result;
        const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
        const logicalPath = JSON.stringify(logicalPaths);
        const hierarchicalTags = [L1, L2, ...knowledgePoints].filter(Boolean);

        await supabase.from('study_notes').update({
          tags: hierarchicalTags,
          papercore,
          logical_path: logicalPath,
          ai_processed: true,
          viewed_after_process: false,
          updated_at: new Date().toISOString(),
        }).eq('id', note.id);

        results.push({ id: note.id, status: 'processed', tags: hierarchicalTags, logical_path: logicalPaths });
      } catch (e: any) {
        console.error(`Failed to process study note ${note.id}:`, e);
        results.push({ id: note.id, status: 'error', error: e.message });
      }
    }

    res.json({ data: results });
  } catch (e: any) {
    console.error('Process study notes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// POST /process-materials (batch, backward compat)
// ==========================================
router.post('/process-materials', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();

    const { data: unprocessed, error: fetchError } = await supabase
      .from('materials')
      .select('*')
      .eq('ai_processed', false)
      .order('created_at', { ascending: false })
      .limit(10);

    if (fetchError) throw fetchError;
    if (!unprocessed || unprocessed.length === 0) {
      return res.json({ data: [], message: 'No unprocessed materials' });
    }

    const results = [];
    for (const material of unprocessed) {
      try {
        const userId = material.user_id || 'guest';

        // Try disk first, fallback to DB
        let text = '';
        const diskText = await readMaterialFileFromDisk(material);
        if (diskText && diskText.trim().length >= 5) {
          text = stripTOC(diskText);
        } else {
          text = extractText(material);
        }

        if (text.trim().length < 5) {
          await supabase.from('materials').update({
            ai_processed: true,
            papercore: text || '',
            logical_path: '/未分类/',
          }).eq('id', material.id);
          results.push({ id: material.id, status: 'skipped' });
          continue;
        }

        const materialFileName = (material as any).name || undefined;

        if (!isReadableText(text)) {
          const degradedPapercore = buildDegradedPapercore(materialFileName);
          await supabase.from('materials').update({
            ai_processed: true,
            papercore: degradedPapercore,
            logical_path: JSON.stringify(['/未分类/']),
          }).eq('id', material.id);
          results.push({ id: material.id, status: 'processed', papercore: degradedPapercore, reason: 'degraded' });
          continue;
        }

        const existingHierarchy = await getExistingTagHierarchy(userId);
                const papercore = await generatePapercore(text, { fileName: materialFileName });
        const result = await generateHierarchicalTags(papercore, text.length, existingHierarchy, userId);

        const { L1, L2, tags: knowledgePoints } = result;
        const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
        const logicalPath = JSON.stringify(logicalPaths);
        const hierarchicalTags = [L1, L2, ...knowledgePoints].filter(Boolean);

        await supabase.from('materials').update({
          tags: hierarchicalTags,
          papercore,
          logical_path: logicalPath,
          ai_processed: true,
          viewed_after_process: false,
          updated_at: new Date().toISOString(),
        }).eq('id', material.id);

        results.push({ id: material.id, status: 'processed', tags: hierarchicalTags, logical_path: logicalPaths });
      } catch (e: any) {
        console.error(`Failed to process material ${material.id}:`, e);
        results.push({ id: material.id, status: 'error', error: e.message });
      }
    }

    res.json({ data: results });
  } catch (e: any) {
    console.error('Process materials error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// GET /graph-data - Knowledge graph with Tag-based nodes
// ==========================================
router.get('/graph-data', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const supabase = getSupabaseClient();

    const [notesRes, materialsRes] = await Promise.all([
      supabase.from('study_notes').select('id, title, tags, papercore, logical_path, created_at').eq('user_id', userId).eq('ai_processed', true).order('created_at', { ascending: false }).limit(100),
      supabase.from('materials').select('id, name, tags, papercore, logical_path, created_at').eq('user_id', userId).eq('ai_processed', true).order('created_at', { ascending: false }).limit(100),
    ]);

    console.log(`[graph-data] notes: ${notesRes.data?.length || 0}, materials: ${materialsRes.data?.length || 0}`);

    const notes: any[] = (notesRes.data || []).map((n: any) => ({
      ...n, type: 'note' as const, title: n.title || '未命名纪要',
    }));
    const materials: any[] = (materialsRes.data || []).map((m: any) => ({
      ...m, type: 'material' as const, title: m.name || '未命名资料',
    }));
    const allRecords = [...notes, ...materials];

    // ====== Build Tag nodes ======
    interface TagNode {
      id: string;
      name: string;
      level: 'L1' | 'L2' | 'L3';
      count: number;
      documentIds: string[];
      parentId?: string;
      children: string[];
      x: number;
      y: number;
    }
    interface TagEdge {
      from: string;
      to: string;
      type: 'hierarchy' | 'cooccurrence';
      weight?: number;
    }

    const tagMap = new Map<string, TagNode>();
    const cooccurrenceMap = new Map<string, number>(); // "tagA|||tagB" -> count
    const docTagMap = new Map<string, Set<string>>(); // docId -> set of tag ids

    allRecords.forEach(record => {
      const tags = (record.tags || []) as string[];
      if (tags.length === 0) return;

      const l1 = tags[0] || '';
      const l2 = tags[1] || '';
      const l3List = tags.slice(2);
      const recordId = `${record.type}_${record.id}`;
      const docTags: string[] = [];

      if (l1) {
        const l1Id = `tag_L1_${l1}`;
        docTags.push(l1Id);
        if (!tagMap.has(l1Id)) {
          tagMap.set(l1Id, { id: l1Id, name: l1, level: 'L1', count: 0, documentIds: [], children: [], x: 0, y: 0 });
        }
        const node = tagMap.get(l1Id)!;
        node.count++;
        if (!node.documentIds.includes(recordId)) node.documentIds.push(recordId);
      }

      if (l2 && l1) {
        const l2Id = `tag_L2_${l1}_${l2}`;
        docTags.push(l2Id);
        if (!tagMap.has(l2Id)) {
          tagMap.set(l2Id, { id: l2Id, name: l2, level: 'L2', count: 0, documentIds: [], children: [], parentId: `tag_L1_${l1}`, x: 0, y: 0 });
        }
        const node = tagMap.get(l2Id)!;
        node.count++;
        if (!node.documentIds.includes(recordId)) node.documentIds.push(recordId);
        const parent = tagMap.get(`tag_L1_${l1}`);
        if (parent && !parent.children.includes(l2Id)) parent.children.push(l2Id);
      }

      for (const l3 of l3List) {
        if (!l3 || !l1 || !l2) continue;
        const l3Id = `tag_L3_${l1}_${l2}_${l3}`;
        docTags.push(l3Id);
        if (!tagMap.has(l3Id)) {
          tagMap.set(l3Id, { id: l3Id, name: l3, level: 'L3', count: 0, documentIds: [], children: [], parentId: `tag_L2_${l1}_${l2}`, x: 0, y: 0 });
        }
        const node = tagMap.get(l3Id)!;
        node.count++;
        if (!node.documentIds.includes(recordId)) node.documentIds.push(recordId);
        const parent = tagMap.get(`tag_L2_${l1}_${l2}`);
        if (parent && !parent.children.includes(l3Id)) parent.children.push(l3Id);
      }

      // Track doc-tag associations for co-occurrence
      if (docTags.length > 0) {
        docTagMap.set(recordId, new Set(docTags));
      }

      // Co-occurrence: tags appearing in the same document
      for (let i = 0; i < docTags.length; i++) {
        for (let j = i + 1; j < docTags.length; j++) {
          const key = docTags[i] < docTags[j] ? `${docTags[i]}|||${docTags[j]}` : `${docTags[j]}|||${docTags[i]}`;
          cooccurrenceMap.set(key, (cooccurrenceMap.get(key) || 0) + 1);
        }
      }
    });

    // ====== Layout: Dynamic concentric + force-directed relaxation ======
    const canvasW = 1200;
    const canvasH = 900;
    const cx = canvasW / 2;
    const cy = canvasH / 2;

    const l1Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L1');
    const l2Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L2');
    const l3Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L3');

    // Node sizes (radius + text label space)
    const getNodeRadius = (level: 'L1' | 'L2' | 'L3'): number => {
      if (level === 'L1') return 50;  // circle 28 + label
      if (level === 'L2') return 35;  // circle 18 + label
      return 22;                       // circle 12 + label
    };

    // L1: spread around center
    const l1Radius = Math.min(canvasW, canvasH) * 0.18;
    l1Nodes.forEach((node, i) => {
      const angle = (i / Math.max(l1Nodes.length, 1)) * 2 * Math.PI - Math.PI / 2;
      node.x = Math.round((cx + l1Radius * Math.cos(angle)) * 100) / 100;
      node.y = Math.round((cy + l1Radius * Math.sin(angle)) * 100) / 100;
    });

    // L2: circle around parent L1 — wider spread for cluster separation
    l2Nodes.forEach(node => {
      if (node.parentId) {
        const parent = tagMap.get(node.parentId);
        if (parent) {
          const totalSiblings = Math.max(parent.children.length, 1);
          // Much wider orbit: more L2s = more spread to give each cluster room
          const orbitRadius = Math.max(140, 80 + totalSiblings * 40);
          const idx = parent.children.indexOf(node.id);
          const angle = (idx / totalSiblings) * 2 * Math.PI - Math.PI / 2;
          node.x = Math.round((parent.x + orbitRadius * Math.cos(angle)) * 100) / 100;
          node.y = Math.round((parent.y + orbitRadius * Math.sin(angle)) * 100) / 100;
        } else {
          node.x = cx + (Math.random() - 0.5) * 200;
          node.y = cy + (Math.random() - 0.5) * 200;
        }
      }
    });

    // L3: circle around parent L2 — dynamic radius + staggered angles
    l3Nodes.forEach(node => {
      if (node.parentId) {
        const parent = tagMap.get(node.parentId);
        if (parent) {
          const totalSiblings = Math.max(parent.children.length, 1);
          // More siblings = larger orbit to avoid overlap
          const orbitRadius = Math.max(55, 20 + totalSiblings * 16);
          const idx = parent.children.indexOf(node.id);
          // Stagger angle slightly if many siblings
          const jitter = totalSiblings > 6 ? (Math.random() - 0.5) * 0.15 : 0;
          const angle = (idx / totalSiblings) * 2 * Math.PI - Math.PI / 2 + jitter;
          node.x = Math.round((parent.x + orbitRadius * Math.cos(angle)) * 100) / 100;
          node.y = Math.round((parent.y + orbitRadius * Math.sin(angle)) * 100) / 100;
        }
      }
    });

    // ====== Force-directed relaxation: cluster-aware collision avoidance ======
    interface SimNode { id: string; x: number; y: number; vx: number; vy: number; fixed: boolean; radius: number; parentId?: string; l2ParentId?: string; level: string; }
    const simNodes = new Map<string, SimNode>();

    // Build L2 parent lookup for L3 nodes
    const l3ToL2Parent = new Map<string, string>();
    for (const l3 of l3Nodes) {
      if (l3.parentId) {
        l3ToL2Parent.set(l3.id, l3.parentId);
      }
    }

    tagMap.forEach(node => {
      simNodes.set(node.id, {
        id: node.id, x: node.x, y: node.y, vx: 0, vy: 0,
        fixed: node.level === 'L1',
        radius: getNodeRadius(node.level),
        parentId: node.parentId,
        l2ParentId: node.level === 'L3' ? l3ToL2Parent.get(node.id) : (node.level === 'L2' ? node.id : undefined),
        level: node.level,
      });
    });

    const simEntries = Array.from(simNodes.values());
    const iterations = 250;
    const repulsionBase = 1200;
    const crossClusterRepulsion = 1500; // stronger push between different L2 clusters
    const parentAttractionL2 = 0.012;   // L2 → L1 attraction
    const parentAttractionL3 = 0.03;    // L3 → L2 attraction (stronger, stay in cluster)
    const damping = 0.65;
    const alphaDecay = 0.995;

    let alpha = 1.0;
    for (let iter = 0; iter < iterations; iter++) {
      alpha *= alphaDecay;
      const currentRepulsion = repulsionBase * alpha;
      const currentCrossRep = crossClusterRepulsion * alpha;

      // 1. Repulsion between all pairs
      for (let i = 0; i < simEntries.length; i++) {
        for (let j = i + 1; j < simEntries.length; j++) {
          const a = simEntries[i], b = simEntries[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;

          // Different L2 clusters → much stronger repulsion and larger safety distance
          const sameL2Cluster = a.l2ParentId && b.l2ParentId && a.l2ParentId === b.l2ParentId;
          const minDist = a.radius + b.radius + (sameL2Cluster ? 8 : 70);
          const repForce = sameL2Cluster ? currentRepulsion : currentRepulsion + currentCrossRep;

          if (dist < minDist) {
            const overlap = minDist - dist;
            const force = overlap / minDist * repForce / Math.max(dist, 8);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
            if (!b.fixed) { b.vx += fx; b.vy += fy; }
          }
        }
      }

      // 2. Attraction to parent (stronger for L3→L2 to keep clusters tight)
      for (const node of simEntries) {
        if (node.fixed || !node.parentId) continue;
        const parent = simNodes.get(node.parentId);
        if (!parent) continue;
        const dx = parent.x - node.x;
        const dy = parent.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const str = node.level === 'L3' ? parentAttractionL3 : parentAttractionL2;
        const force = dist * str * alpha;
        node.vx += (dx / dist) * force;
        node.vy += (dy / dist) * force;
      }

      // 3. L2 → L2 extra repulsion (push clusters apart)
      for (let i = 0; i < l2Nodes.length; i++) {
        for (let j = i + 1; j < l2Nodes.length; j++) {
          const a = simNodes.get(l2Nodes[i].id), b = simNodes.get(l2Nodes[j].id);
          if (!a || !b) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const minDist = a.radius + b.radius + 120;
          if (dist < minDist) {
            const force = (minDist - dist) / minDist * currentRepulsion * 1.5 / Math.max(dist, 5);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }
      }

      // 4. Apply velocities
      for (const node of simEntries) {
        if (node.fixed) continue;
        node.vx *= damping;
        node.vy *= damping;
        const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
        if (speed > 6) { node.vx = node.vx / speed * 6; node.vy = node.vy / speed * 6; }
        node.x += node.vx;
        node.y += node.vy;
        // Soft boundaries
        const margin = node.radius + 15;
        if (node.x < margin) node.vx += (margin - node.x) * 0.3;
        if (node.x > canvasW - margin) node.vx -= (node.x - (canvasW - margin)) * 0.3;
        if (node.y < margin) node.vy += (margin - node.y) * 0.3;
        if (node.y > canvasH - margin) node.vy -= (node.y - (canvasH - margin)) * 0.3;
        node.x = Math.max(node.radius + 5, Math.min(canvasW - node.radius - 5, node.x));
        node.y = Math.max(node.radius + 5, Math.min(canvasH - node.radius - 5, node.y));
      }
    }

    // Write back simulated positions
    simNodes.forEach((sim, id) => {
      const tagNode = tagMap.get(id);
      if (tagNode) {
        tagNode.x = Math.round(sim.x * 100) / 100;
        tagNode.y = Math.round(sim.y * 100) / 100;
      }
    });

    // ====== Build edges ======
    const edges: TagEdge[] = [];

    // Hierarchical edges
    tagMap.forEach(node => {
      if (node.parentId && tagMap.has(node.parentId)) {
        edges.push({ from: node.parentId, to: node.id, type: 'hierarchy' });
      }
    });

    // Co-occurrence edges (top 50 by weight)
    const coocSorted = Array.from(cooccurrenceMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    coocSorted.forEach(([key, weight]) => {
      const [a, b] = key.split('|||');
      if (tagMap.has(a) && tagMap.has(b)) {
        edges.push({ from: a, to: b, type: 'cooccurrence', weight });
      }
    });

    // ====== Domain circles (based on L1 tags, dynamic radius from children) ======
    const domains = l1Nodes.map(node => {
      // Find furthest child (L2 or L3) to determine domain radius
      let maxDist = 0;
      for (const child of l2Nodes) {
        if (child.parentId === node.id) {
          const dx = child.x - node.x, dy = child.y - node.y;
          maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy) + 50);
          // Also check L3 children
          for (const l3 of l3Nodes) {
            if (l3.parentId === child.id) {
              const d3x = l3.x - node.x, d3y = l3.y - node.y;
              maxDist = Math.max(maxDist, Math.sqrt(d3x * d3x + d3y * d3y) + 25);
            }
          }
        }
      }
      return {
        name: node.name,
        cx: node.x, cy: node.y,
        r: Math.max(130, Math.ceil(maxDist)),
        count: node.count,
      };
    });

    res.json({
      data: {
        nodes: Array.from(tagMap.values()),
        edges,
        domains,
        canvas: { width: canvasW, height: canvasH },
        totalRecords: allRecords.length,
      },
    });
  } catch (e: any) {
    console.error('graph-data error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// GET /tag-documents — documents for a specific tag
// ==========================================
router.get('/tag-documents', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const tag = (req.query.tag as string) || '';
    if (!tag) {
      return res.status(400).json({ error: 'tag query parameter is required' });
    }

    const supabase = getSupabaseClient();

    // tag is the display name (not the full ID). Match against tags arrays
    const [notesRes, materialsRes] = await Promise.all([
      supabase.from('study_notes').select('id, title, tags, papercore, logical_path, created_at').eq('user_id', userId).eq('ai_processed', true).order('created_at', { ascending: false }).limit(200),
      supabase.from('materials').select('id, name, tags, papercore, logical_path, created_at').eq('user_id', userId).eq('ai_processed', true).order('created_at', { ascending: false }).limit(200),
    ]);

    const matchTag = (recordTags: string[] | null) => {
      if (!recordTags || !Array.isArray(recordTags)) return false;
      return recordTags.some(t => t === tag);
    };

    const matchedNotes = (notesRes.data || []).filter((n: any) => matchTag(n.tags)).map((n: any) => ({
      id: n.id,
      title: n.title || '未命名纪要',
      type: 'study_note' as const,
      papercore: n.papercore || '',
      tags: n.tags || [],
      logical_path: n.logical_path || '',
      created_at: n.created_at || '',
    }));

    const matchedMaterials = (materialsRes.data || []).filter((m: any) => matchTag(m.tags)).map((m: any) => ({
      id: m.id,
      title: m.name || '未命名资料',
      type: 'material' as const,
      papercore: m.papercore || '',
      tags: m.tags || [],
      logical_path: m.logical_path || '',
      created_at: m.created_at || '',
    }));

    const documents = [...matchedNotes, ...matchedMaterials].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    res.json({ data: documents });
  } catch (e: any) {
    console.error('tag-documents error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// POST /trigger - Trigger processing for unprocessed records
// ==========================================
router.post('/trigger', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();

    const [notesRes, materialsRes] = await Promise.all([
      supabase.from('study_notes').select('id').eq('ai_processed', false).limit(100),
      supabase.from('materials').select('id').eq('ai_processed', false).limit(100),
    ]);

    const noteIds = (notesRes.data || []).map((n: any) => n.id);
    const materialIds = (materialsRes.data || []).map((m: any) => m.id);

    res.json({
      data: {
        unprocessedStudyNotes: noteIds.length,
        unprocessedMaterials: materialIds.length,
        total: noteIds.length + materialIds.length,
      },
    });
  } catch (e: any) {
    console.error('trigger error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// Tag consolidation: LLM-based synonym detection only
// Merges truly identical tags (e.g. "复分析" → "复变函数")
// Does NOT merge related-but-different concepts
// ==========================================
async function consolidateTags(userId: string): Promise<{ merged: { tag: string; into: string; level: string }[] }> {
  const supabase = getSupabaseClient();
  const hierarchy = await getExistingTagHierarchy(userId);
  const merged: { tag: string; into: string; level: string }[] = [];

  if (hierarchy.L2.length <= 1) return { merged };

  // Helper to apply a merge across both tables
  const applyMerge = async (from: string, to: string) => {
    if (from === to) return;
    for (const table of ['study_notes', 'materials']) {
      const { data: records } = await supabase.from(table).select('id, tags, logical_path').eq('user_id', userId);
      for (const r of (records || [])) {
        const tags: string[] = r.tags || [];
        const updated = tags.map(t => t === from ? to : t);
        const deduped = updated.filter((t, i) => t !== updated[i - 1]);
        if (deduped.join(',') !== tags.join(',')) {
          // Handle logical_path as JSON array (new format) or plain string (legacy)
          const rawPath = r.logical_path || '[]';
          let paths: string[];
          try {
            paths = JSON.parse(rawPath);
            if (!Array.isArray(paths)) paths = [rawPath];
          } catch {
            paths = [rawPath];
          }
          const newPaths = paths.map(p => p.replace(`/${from}/`, `/${to}/`));
          await supabase.from(table).update({
            tags: deduped,
            logical_path: JSON.stringify(newPaths),
          }).eq('id', r.id);
        }
      }
    }
  };

  // L2-level programmatic dedup before LLM
  // Substring match: if one L2 name is contained in another → merge shorter into longer
  const l2Tags = [...hierarchy.L2].sort((a, b) => b.length - a.length); // longest first
  for (let i = 0; i < l2Tags.length; i++) {
    for (let j = i + 1; j < l2Tags.length; j++) {
      const longer = l2Tags[i];
      const shorter = l2Tags[j];
      if (longer !== shorter && longer.includes(shorter) && shorter.length >= 2) {
        console.log(`[consolidate] substring merge: "${shorter}" → "${longer}"`);
        await applyMerge(shorter, longer);
        merged.push({ tag: shorter, into: longer, level: 'L2' });
        // Remove from arrays
        hierarchy.L2 = hierarchy.L2.filter(t => t !== shorter);
      }
    }
  }

  // Known L2 synonym pairs (embedding/substring can't catch)
  const knownSynonyms: [string, string][] = [
    ['复变函数', '复分析'],
    ['抽样理论', '统计学'],
    ['数理统计', '统计学'],
    ['最优化方法', '运筹学'],
  ];
  for (const [from, to] of knownSynonyms) {
    if (hierarchy.L2.includes(from) && hierarchy.L2.includes(to)) {
      console.log(`[consolidate] known synonym: "${from}" → "${to}"`);
      await applyMerge(from, to);
      merged.push({ tag: from, into: to, level: 'L2' });
      hierarchy.L2 = hierarchy.L2.filter(t => t !== from);
    }
  }

  // Build L2→L3s mapping for cross-L2 L3 dedup
  const supabase2 = getSupabaseClient();
  const [notesRes2, materialsRes2] = await Promise.all([
    supabase2.from('study_notes').select('tags').eq('user_id', userId).not('tags', 'is', null),
    supabase2.from('materials').select('tags').eq('user_id', userId).not('tags', 'is', null),
  ]);
  const l2ToL3s = new Map<string, Set<string>>();
  for (const r of [...(notesRes2.data || []), ...(materialsRes2.data || [])]) {
    const tags: string[] = r.tags || [];
    if (tags.length >= 3) {
      const l2 = tags[1];
      if (!l2ToL3s.has(l2)) l2ToL3s.set(l2, new Set());
      for (let i = 2; i < tags.length; i++) {
        if (tags[i]) l2ToL3s.get(l2)!.add(tags[i]);
      }
    }
  }

  // --- LLM consolidation: L2 synonyms + cross-L2 L3 dedup ---
  const l2Only = [...hierarchy.L2].filter(l2 => l2);
  if (l2Only.length > 1) {
    // Build compact representation: each L2 with its top L3s (max 8 per L2)
    const l2Summaries = l2Only.map(l2 => {
      const l3s = [...(l2ToL3s.get(l2) || new Set())].slice(0, 8);
      return `"${l2}" → [${l3s.join(', ')}]`;
    }).join('\n');

    const prompt = `你是学科分类与标签去重专家。分析以下二级学科(L2)及其包含的章节(L3)：

${l2Summaries}

任务：
1. 找出含义相同、仅是不同叫法的L2标签对（如"复分析"="复变函数"）
2. 如果两个L2下有大量相同/同义的L3，应合并这两个L2
3. 不要合并不同的子学科

输出JSON数组（没有则[]）：
[{"merge":"被合并标签", "into":"保留标签", "level":"L2"}]`;

    try {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 512,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      });
      const content = response.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const pairs: { merge: string; into: string; level: string }[] = JSON.parse(jsonMatch[0]);
        for (const pair of pairs) {
          if (pair.merge === pair.into) continue;
          const level = pair.level || 'L2';
          const exists = hierarchy[level as 'L2']?.includes(pair.merge);
          if (!exists) continue;
          console.log(`[consolidate] LLM merge: "${pair.merge}" → "${pair.into}" (${level})`);
          await applyMerge(pair.merge, pair.into);
          merged.push({ tag: pair.merge, into: pair.into, level });
          hierarchy.L2 = hierarchy.L2.filter(t => t !== pair.merge);
        }
      }
    } catch (e) {
      console.error('consolidateTags LLM error:', e);
    }
  }

  return { merged };
}

// ==========================================
// POST /rebuild-all — Reset and re-process ALL records
// ==========================================
router.post('/rebuild-all', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const supabase = getSupabaseClient();

    await Promise.all([
      supabase.from('study_notes').update({ ai_processed: false, papercore: '', tags: [], logical_path: '' }).eq('user_id', userId),
      supabase.from('materials').update({ ai_processed: false, papercore: '', tags: [], logical_path: '' }).eq('user_id', userId),
    ]);

    const [notesRes, materialsRes] = await Promise.all([
      supabase.from('study_notes').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('materials').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    ]);

    const notes = notesRes.data || [];
    const materials = materialsRes.data || [];
    let processed = 0;
    const errors: any[] = [];
    // Dynamic hierarchy: update after each file so later files can inherit earlier files' tags
    const existingHierarchy = await getExistingTagHierarchy(userId);
    
    const updateHierarchy = (l1: string, l2: string, l3s: string[]) => {
      if (l1 && !existingHierarchy.L1.includes(l1)) existingHierarchy.L1.push(l1);
      if (l2 && !existingHierarchy.L2.includes(l2)) existingHierarchy.L2.push(l2);
      for (const kp of l3s) {
        if (kp && !existingHierarchy.L3.includes(kp)) existingHierarchy.L3.push(kp);
      }
    };

    const perFileLog: any[] = [];

    for (const note of notes) {
      try {
        const text = extractText(note);
        if (!text || text.trim().length < 5) {
          await supabase.from('study_notes').update({ ai_processed: true, papercore: text || '', logical_path: '/未分类/' }).eq('id', note.id).eq('user_id', userId);
          processed++; continue;
        }
        const noteFileName = (note as any).title || undefined;
        const papercore = await generatePapercore(text, { fileName: noteFileName });
        const result = await generateHierarchicalTags(papercore, text.length, existingHierarchy, userId);
        const { L1, L2, tags: knowledgePoints } = result;
        const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
        const logicalPath = JSON.stringify(logicalPaths);
        const notePayload = {
          tags: [L1, L2, ...knowledgePoints].filter(Boolean), papercore, logical_path: logicalPath,
          ai_processed: true, viewed_after_process: false, updated_at: new Date().toISOString(),
        };
        const { error: updateErr } = await supabase.from('study_notes').update(notePayload).eq('id', note.id).eq('user_id', userId);
        if (updateErr) throw new Error(updateErr.message);
        updateHierarchy(L1, L2, knowledgePoints);
        perFileLog.push({ id: note.id, name: note.name || (note.content||'').slice(0,40), type: 'study_note', L1, L2, L3s: knowledgePoints, papercore: papercore.slice(0,100), paths: logicalPaths });
        processed++;
      } catch (e: any) { errors.push({ id: note.id, type: 'study_note', error: e.message }); }
    }

    for (const material of materials) {
      try {
        let text = '';
        const diskText = await readMaterialFileFromDisk(material);
        if (diskText && diskText.trim().length >= 5) text = stripTOC(diskText);
        else text = extractText(material);

        if (!text || text.trim().length < 5) {
          await supabase.from('materials').update({ ai_processed: true, papercore: text || '', logical_path: '/未分类/' }).eq('id', material.id).eq('user_id', userId);
          processed++; continue;
        }
        if (!isReadableText(text)) {
          const matName = material.name || '';
          // Defer Bi_ORC files for batch processing after main loop
          if (/^Bi_/i.test(matName)) {
            perFileLog.push({ id: material.id, name: matName.slice(0,60), type: 'material', L1: '', L2: '', L3s: [], papercore: '', paths: [], skipped: 'degraded_bi_orc' });
            processed++; continue;
          }
          const degradedPapercore = buildDegradedPapercore(matName);
          await supabase.from('materials').update({ ai_processed: true, papercore: degradedPapercore, logical_path: JSON.stringify(['/未分类/']) }).eq('id', material.id).eq('user_id', userId);
          perFileLog.push({ id: material.id, name: matName.slice(0,60), type: 'material', L1: '', L2: '', L3s: [], papercore: degradedPapercore.slice(0, 120), paths: ['/未分类/'], skipped: 'degraded' });
          processed++; continue;
        }
        const matFileName = (material as any).name || undefined;
        const papercore = await generatePapercore(text, { fileName: matFileName });
        const result = await generateHierarchicalTags(papercore, text.length, existingHierarchy, userId);
        const { L1, L2, tags: knowledgePoints } = result;
        const logicalPaths = buildLogicalPaths(L1, L2, knowledgePoints);
        const logicalPath = JSON.stringify(logicalPaths);
        const matPayload = {
          tags: [L1, L2, ...knowledgePoints].filter(Boolean), papercore, logical_path: logicalPath,
          ai_processed: true, viewed_after_process: false, updated_at: new Date().toISOString(),
        };
        const { error: updateErr2 } = await supabase.from('materials').update(matPayload).eq('id', material.id).eq('user_id', userId);
        if (updateErr2) throw new Error(updateErr2.message);
        updateHierarchy(L1, L2, knowledgePoints);
        perFileLog.push({ id: material.id, name: material.name?.slice(0,60), type: 'material', L1, L2, L3s: knowledgePoints, papercore: papercore.slice(0,120), paths: logicalPaths });
        processed++;
      } catch (e: any) { errors.push({ id: material.id, type: 'material', error: e.message }); }
    }

    // ==========================================
    // Post-rebuild L2 reassignment pass
    // Re-evaluate each document's L1/L2 using the complete final tree
    // (fixes sequencing issues where early docs couldn't see later-created L2s)
    // ==========================================
    const finalTree = await buildL1L2Tree(userId);
    const finalTreeText = formatL1L2Tree(finalTree);
    const finalL1s = Array.from(finalTree.keys());
    const finalL2s = Array.from(finalTree.values()).flatMap(s => Array.from(s));

    console.log(`[l2-reassign] Final tree: ${finalL1s.length} L1s, ${finalL2s.length} L2s — ${finalTreeText.replace(/\n/g, ' | ')}`);

    let reassigned = 0;
    const INVALID = new Set(['无','未知','未分类','无法识别','无法确定','无法分类','其他','其它','未标注']);

    for (const entry of perFileLog) {
      const oldL2 = entry.L2;
      const papercore = entry.papercore || '';
      if (!papercore || papercore.startsWith('该文档以公式') || papercore.startsWith('该文档因严重编码')) continue;
      if (!entry.L1 || !entry.L2) continue;

      const reassignPrompt = `你是学科分类专家。以下是完整的学科树和一份文档。请判断此文档的L2归属是否需要修正。

完整学科树：
${finalTreeText}

文档当前分类：${entry.L1} > ${entry.L2}
文档摘要：
${papercore.slice(0, 600)}

规则：
1. 如果当前L2已经是该文档最佳归属，输出不变
2. 如果有更合适的L2（学科树中已存在），输出修正后的L2
3. L1同理：如果当前L1不匹配学科树中的L1，修正之
4. L1/L2名称必须与学科树中完全一致

输出JSON：{"L1":"...", "L2":"...", "changed":true/false, "reasoning":"..."}`;

      try {
        const resp2 = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 200,
          temperature: 0.2,
          messages: [{ role: 'user', content: reassignPrompt }],
        });
        const c2 = resp2.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('').trim();
        const m2 = c2.match(/\{[\s\S]*\}/);
        if (m2) {
          const parsed = JSON.parse(m2[0]);
          const newL1 = (parsed.L1 || entry.L1).trim();
          const newL2 = (parsed.L2 || entry.L2).trim();
          const changed = parsed.changed === true || parsed.changed === 'true';
          if (INVALID.has(newL1) || INVALID.has(newL2)) continue;

          // Validate against final tree
          const validL1 = finalL1s.includes(newL1) ? newL1 : (finalL1s.includes(entry.L1) ? entry.L1 : finalL1s[0]);
          const validL2 = finalL2s.includes(newL2) || (finalTree.get(validL1)?.has(newL2))
            ? newL2 : finalL2s.includes(entry.L2) ? entry.L2 : Array.from(finalTree.get(validL1) || [])[0];

          if (validL2 && validL2 !== oldL2) {
            console.log(`[l2-reassign] ${entry.name || entry.id}: "${oldL2}" → "${validL2}" | ${parsed.reasoning || 'no reason'}`);

            // Update DB
            const table = entry.type === 'study_note' ? 'study_notes' : 'materials';
            const oldTags = [entry.L1, entry.L2, ...(entry.L3s || [])];
            const newTags = [validL1, validL2, ...(entry.L3s || [])].filter(Boolean);
            const newLogicalPaths = buildLogicalPaths(validL1, validL2, entry.L3s || []);
            await (supabase as any).from(table).update({
              tags: newTags,
              logical_path: JSON.stringify(newLogicalPaths),
              updated_at: new Date().toISOString(),
            }).eq('id', entry.id).eq('user_id', userId);

            // Update perFileLog
            entry.L1 = validL1;
            entry.L2 = validL2;
            entry.paths = newLogicalPaths;
            entry.reassigned = true;
            reassigned++;
          }
        }
      } catch (e) {
        // Individual reassign failures are non-fatal
        console.error(`[l2-reassign] Error for ${entry.name || entry.id}:`, e);
      }
    }

    console.log(`[l2-reassign] Complete: ${reassigned} documents reassigned`);

    // ==========================================
    // Bi_ORC batch processing pass
    // Force-classify unreadable Bi_* PDFs under 运筹学
    // ==========================================
    const biOrcEntries = perFileLog.filter(e => e.skipped === 'degraded_bi_orc');
    if (biOrcEntries.length > 0) {
      console.log(`[bi-orc] Batch processing ${biOrcEntries.length} Bi_ORC files...`);
      const orcExistingL3s = await getAllL3NamesUnderL2(userId, '数学', '运筹学');
      const biOrcFilenames = biOrcEntries.map(e => e.name).join('\n');

      const biOrcPrompt = `你是运筹学（Operations Research）课程专家。以下是一批运筹学课程PDF的文件名，由于PDF编码问题无法提取文本，请根据文件名推断每个文件的核心话题。

文件名列表：
${biOrcFilenames}

运筹学下已有L3标签：${orcExistingL3s.join(', ') || '(尚无)'}

标准运筹学课程体系参考：线性规划、单纯形法、对偶理论、灵敏度分析、运输问题、指派问题、网络优化、动态规划、整数规划、博弈论、决策分析、排队论、库存论、非线性规划。

规则：
1. Bi_ORC{N} 中 N 对应课程模块，week{X} 对应教学周，据此推断话题
2. L3标签必须使用大类名称（如"对偶理论"而非"互补松弛定理"），优先复用已有标签
3. 同模块不同周可能有不同话题，请区分
4. 每个文件最多3个L3标签

输出JSON数组：
[{"filename":"...", "topic":"简要话题描述", "l3s":["大类标签1","大类标签2"]}, ...]`;

      try {
        const resp = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 2048,
          temperature: 0.3,
          messages: [{ role: 'user', content: biOrcPrompt }],
        });
        const content = resp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          for (const entry of parsed) {
            const logEntry = biOrcEntries.find(e => e.name === entry.filename);
            if (!logEntry) continue;
            const l3s = (entry.l3s || []).slice(0, 3);
            const L1 = '数学', L2 = '运筹学';
            const papercore = entry.topic || `运筹学课程：${entry.filename}`;
            const logicalPaths = buildLogicalPaths(L1, L2, l3s);

            await (supabase as any).from('materials').update({
              tags: [L1, L2, ...l3s].filter(Boolean),
              papercore,
              logical_path: JSON.stringify(logicalPaths),
              ai_processed: true, updated_at: new Date().toISOString(),
            }).eq('id', logEntry.id).eq('user_id', userId);

            logEntry.L1 = L1; logEntry.L2 = L2; logEntry.L3s = l3s;
            logEntry.papercore = papercore.slice(0, 120); logEntry.paths = logicalPaths;
            delete logEntry.skipped; (logEntry as any).forced = true;
            updateHierarchy(L1, L2, l3s);
            console.log(`[bi-orc] ${entry.filename}: ${l3s.join(', ')}`);
          }
        }
      } catch (e) {
        console.error('[bi-orc] Batch LLM error:', e);
      }
    }

    const { merged } = await consolidateTags(userId);

    // ==========================================
    // L3 consolidation for 运筹学 — merge fine-grained L3s into broad categories
    // ==========================================
    const orcL3s = await getAllL3NamesUnderL2(userId, '数学', '运筹学');
    if (orcL3s.length > 3) {
      console.log(`[l3-consolidate] 运筹学 has ${orcL3s.length} L3s, checking consolidation...`);

      const l3ConsolidatePrompt = `你是运筹学标签管理专家。以下是运筹学下的所有L3标签，其中有些过于细碎，需合并为更宽的类别。

当前L3标签（${orcL3s.length}个）：
${orcL3s.join('\n')}

规则：
1. 细碎标签合并：将过细的子标签合并到其所属的大类（如"互补松弛定理"→"对偶理论"，"退化现象"→"运输问题"）
2. 保留核心大类独立：对偶理论、动态规划、运输问题等大类各自独立
3. 不合并不同学科方向
4. 若标签已是合适的大类粒度则保留
5. 运筹学标准大类参考：线性规划、单纯形法、对偶理论、运输问题、动态规划、整数规划、博弈论、决策分析、网络优化、非线性规划、排队论、库存论

输出JSON（无变化则[]）：
[{"merge":"细碎标签", "into":"大类标签"}, ...]`;

      try {
        const resp = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          temperature: 0.2,
          messages: [{ role: 'user', content: l3ConsolidatePrompt }],
        });
        const content = resp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const merges: { merge: string; into: string }[] = JSON.parse(jsonMatch[0]);
          let l3Merged = 0;
          for (const { merge: from, into: to } of merges) {
            if (from === to || !orcL3s.includes(from)) continue;
            console.log(`[l3-consolidate] 运筹学 L3: "${from}" → "${to}"`);
            for (const table of ['study_notes', 'materials']) {
              const { data: records } = await (supabase as any).from(table).select('id, tags, logical_path').eq('user_id', userId);
              for (const r of (records || [])) {
                const tags: string[] = r.tags || [];
                if (tags.length >= 3 && tags[1] === '运筹学' && tags.includes(from)) {
                  const updated = tags.map(t => t === from ? to : t);
                  const deduped = updated.filter((t, i) => updated.indexOf(t) === i);
                  const rawPath = r.logical_path || '[]';
                  let paths: string[];
                  try { paths = JSON.parse(rawPath); if (!Array.isArray(paths)) paths = [rawPath]; }
                  catch { paths = [rawPath]; }
                  const newPaths = paths.map((p: string) => p.replace(`/${from}/`, `/${to}/`));
                  await (supabase as any).from(table).update({
                    tags: deduped, logical_path: JSON.stringify(newPaths),
                  }).eq('id', r.id);
                }
              }
            }
            l3Merged++;
          }
          if (l3Merged > 0) console.log(`[l3-consolidate] 运筹学: ${l3Merged} L3 merges completed`);
        }
      } catch (e) {
        console.error('[l3-consolidate] LLM error:', e);
      }
    }

    res.json({
      data: { total: notes.length + materials.length, processed, merged, reassigned,
        perFileLog,
        errors: errors.length > 0 ? errors : undefined,
        message: `${processed}/${notes.length + materials.length} 处理${merged.length > 0 ? `, ${merged.length} 组合并` : ''}${reassigned > 0 ? `, ${reassigned} 个重新分配L2` : ''}` },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// POST /consolidate-tags
// ==========================================
router.post('/consolidate-tags', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { merged } = await consolidateTags(userId);
    res.json({ data: { merged, message: merged.length > 0 ? `合并 ${merged.length} 组` : '无需合并' } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// POST /migrate-add-conflict-column — Add embedding_conflict column
// ==========================================
router.post('/migrate-add-conflict-column', async (_req, res) => {
  try {
    const supabase = getSupabaseClient();
    const results: string[] = [];

    for (const table of ['study_notes', 'materials']) {
      try {
        // Try updating a non-existent record to test if column exists
        const { error } = await supabase.from(table).update({
          embedding_conflict: false,
        }).eq('id', '00000000-0000-0000-0000-000000000000');

        if (error) {
          if (error.message.includes('embedding_conflict') || error.code === '42703') {
            // Column doesn't exist — add it via raw SQL
            const { error: sqlError } = await supabase.rpc('add_embedding_conflict_column', { table_name: table });
            if (sqlError) {
              // RPC not available, try direct approach
              results.push(`${table}: column missing (run: ALTER TABLE ${table} ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE)`);
            } else {
              results.push(`${table}: column added via RPC`);
            }
          } else {
            results.push(`${table}: column exists or other error: ${error.message}`);
          }
        } else {
          results.push(`${table}: column already exists`);
        }
      } catch (e: any) {
        results.push(`${table}: check failed: ${e.message}`);
      }
    }

    res.json({ data: { results, manual: 'If column missing, run in Supabase SQL Editor: ALTER TABLE study_notes ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE; ALTER TABLE materials ADD COLUMN embedding_conflict BOOLEAN DEFAULT FALSE;' } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
