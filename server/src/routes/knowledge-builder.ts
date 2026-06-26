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
    // Try to parse as hierarchical tags array [L1, L2, L3]
    if (tagArr.length >= 1 && tagArr[0]) L1.add(tagArr[0]);
    if (tagArr.length >= 2 && tagArr[1]) L2.add(tagArr[1]);
    if (tagArr.length >= 3 && tagArr[2]) L3.add(tagArr[2]);
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
  // Count CJK characters, ASCII letters, digits, and common punctuation
  const readable = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9\s.,;:!?()\[\]{}\-+=_"'<>/\\@#$%^&*]/g);
  if (!readable) return false;
  return readable.length / text.length > 0.3;
}

// ==========================================
// Helper: Generate hierarchical tags via LLM
// ==========================================
async function generateHierarchicalTags(
  text: string,
  existingHierarchy: { L1: string[]; L2: string[]; L3: string[] }
): Promise<{ L1: string; L2: string; L3: string }> {
  const prompt = `现有标签库：
L1（学科/领域）：[${existingHierarchy.L1.join(', ') || '无'}]
L2（章节/模块）：[${existingHierarchy.L2.join(', ') || '无'}]
L3（具体知识点）：[${existingHierarchy.L3.join(', ') || '无'}]

请为以下内容生成层级标签，必须输出纯JSON格式（不要markdown代码块）：
{"L1":"", "L2":"", "L3":""}

规则：
1. 优先从现有标签库中匹配复用
2. 如果能匹配到L3，直接复用并继承其父级
3. 如果只能匹配到L2，可只输出L1和L2（L3留空""），无需强行补全L3
4. 如果只能匹配到L1，可只输出L1（L2和L3留空""），无需强行补全
5. 只有完全无法匹配时，才允许新建L1
6. 重要：L2和L3可以为空字符串""。对于覆盖面广的综合性内容（如整本教材、完整课程讲义），只需输出L1和L2，L3留空

内容：
${text.slice(0, 1500)}`;

  try {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim();

    // Parse JSON from response (handle possible markdown wrapping)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        L1: parsed.L1 || '',
        L2: parsed.L2 || '',
        L3: parsed.L3 || '',
      };
    }
    return { L1: '', L2: '', L3: '' };
  } catch (e) {
    console.error('LLM tag generation failed:', e);
    return { L1: '', L2: '', L3: '' };
  }
}

// ==========================================
// Helper: Generate papercore summary via LLM
// ==========================================
async function generatePapercore(text: string): Promise<string> {
  if (!text || text.trim().length < 10) return text.trim();

  // Sample from beginning, middle, and end for long documents
  let sampleText: string;
  if (text.length > 6000) {
    const third = Math.floor(text.length / 3);
    sampleText = `[开头]\n${text.slice(0, 1200)}\n\n[中段]\n${text.slice(third, third + 800)}\n\n[末尾]\n${text.slice(-800)}`;
  } else {
    sampleText = text.slice(0, 2000);
  }

  const prompt = `请为以下学习内容生成80-150字的简洁Papercore摘要（核心要点）。要概括全文的整体主题和知识范围，不要只描述开头部分。只输出摘要文本，不要任何前缀或格式：

${sampleText}`;

  try {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim();

    return content || text.slice(0, 150);
  } catch (e) {
    console.error('LLM papercore generation failed:', e);
    return text.slice(0, 150);
  }
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

    // Check text readability (filter garbled PDF content)
    if (!isReadableText(text)) {
      await supabase.from(table).update({
        ai_processed: true,
        papercore: '该文档内容以图表、公式或编码格式为主，无法提取可读文本。建议手动撰写学习摘要。',
        logical_path: '/未分类/',
      }).eq('id', id).eq('user_id', userId);
      return res.json({ data: { id, status: 'skipped', reason: 'garbled or formula-heavy content' } });
    }

    // Get existing tag hierarchy
    const existingHierarchy = await getExistingTagHierarchy(userId);

    // Generate tags and papercore in parallel
    const [tags, papercore] = await Promise.all([
      generateHierarchicalTags(text, existingHierarchy),
      generatePapercore(text),
    ]);

    // Build logical path
    const logicalPath = tags.L1
      ? `/${tags.L1}${tags.L2 ? `/${tags.L2}` : ''}${tags.L3 ? `/${tags.L3}` : ''}/`
      : '/未分类/';

    const hierarchicalTags = [tags.L1, tags.L2, tags.L3].filter(Boolean);

    // Update the record
    const { error: updateError } = await supabase
      .from(table)
      .update({
        tags: hierarchicalTags,
        papercore,
        logical_path: logicalPath,
        ai_processed: true,
        viewed_after_process: false,

        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId);

    if (updateError) throw new Error(updateError.message);

    res.json({
      data: {
        id,
        tags: hierarchicalTags,
        papercore,
        logical_path: logicalPath,
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

    if (!isReadableText(fileContent)) {
      await supabase.from('materials').update({
        ai_processed: true,
        papercore: '该文档内容以图表、公式或编码格式为主，无法提取可读文本。建议手动撰写学习摘要。',
        logical_path: '/未分类/',
      }).eq('id', id).eq('user_id', userId);
      return res.json({ data: { id, status: 'skipped', reason: 'garbled or formula-heavy content' } });
    }

    // 5. Generate tags and papercore
    const existingHierarchy = await getExistingTagHierarchy(userId);
    const [tags, papercore] = await Promise.all([
      generateHierarchicalTags(fileContent, existingHierarchy),
      generatePapercore(fileContent),
    ]);

    const logicalPath = tags.L1
      ? `/${tags.L1}${tags.L2 ? `/${tags.L2}` : ''}${tags.L3 ? `/${tags.L3}` : ''}/`
      : '/未分类/';

    const hierarchicalTags = [tags.L1, tags.L2, tags.L3].filter(Boolean);

    // 6. Update
    await supabase.from('materials').update({
      tags: hierarchicalTags,
      papercore,
      logical_path: logicalPath,
      ai_processed: true,
      viewed_after_process: false,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('user_id', userId);

    res.json({
      data: {
        id,
        tags: hierarchicalTags,
        papercore,
        logical_path: logicalPath,
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
        const [tags, papercore] = await Promise.all([
          generateHierarchicalTags(text, existingHierarchy),
          generatePapercore(text),
        ]);

        const logicalPath = tags.L1
          ? `/${tags.L1}${tags.L2 ? `/${tags.L2}` : ''}${tags.L3 ? `/${tags.L3}` : ''}/`
          : '/未分类/';

        const hierarchicalTags = [tags.L1, tags.L2, tags.L3].filter(Boolean);

        await supabase.from('study_notes').update({
          tags: hierarchicalTags,
          papercore,
          logical_path: logicalPath,
          ai_processed: true,
          viewed_after_process: false,
  
          updated_at: new Date().toISOString(),
        }).eq('id', note.id);

        results.push({ id: note.id, status: 'processed', tags: hierarchicalTags, logical_path: logicalPath });
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
        const text = extractText(material);

        if (text.trim().length < 5) {
          await supabase.from('materials').update({
            ai_processed: true,
            papercore: text || '',
            logical_path: '/未分类/',
          }).eq('id', material.id);
          results.push({ id: material.id, status: 'skipped' });
          continue;
        }

        const existingHierarchy = await getExistingTagHierarchy(userId);
        const [tags, papercore] = await Promise.all([
          generateHierarchicalTags(text, existingHierarchy),
          generatePapercore(text),
        ]);

        const logicalPath = tags.L1
          ? `/${tags.L1}${tags.L2 ? `/${tags.L2}` : ''}${tags.L3 ? `/${tags.L3}` : ''}/`
          : '/未分类/';

        const hierarchicalTags = [tags.L1, tags.L2, tags.L3].filter(Boolean);

        await supabase.from('materials').update({
          tags: hierarchicalTags,
          papercore,
          logical_path: logicalPath,
          ai_processed: true,
          viewed_after_process: false,
  
          updated_at: new Date().toISOString(),
        }).eq('id', material.id);

        results.push({ id: material.id, status: 'processed', tags: hierarchicalTags, logical_path: logicalPath });
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

      const [l1, l2, l3] = tags;
      const recordId = `${record.type}_${record.id}`;
      const docTags: string[] = [];

      // L1 tag
      if (l1) {
        const l1Id = `tag_L1_${l1}`;
        docTags.push(l1Id);
        if (!tagMap.has(l1Id)) {
          tagMap.set(l1Id, { id: l1Id, name: l1, level: 'L1', count: 0, documentIds: [], children: [], x: 0, y: 0 });
        }
        const node = tagMap.get(l1Id)!;
        node.count++;
        node.documentIds.push(recordId);
      }

      // L2 tag
      if (l2 && l1) {
        const l2Id = `tag_L2_${l1}_${l2}`;
        docTags.push(l2Id);
        if (!tagMap.has(l2Id)) {
          tagMap.set(l2Id, { id: l2Id, name: l2, level: 'L2', count: 0, documentIds: [], children: [], parentId: `tag_L1_${l1}`, x: 0, y: 0 });
        }
        const node = tagMap.get(l2Id)!;
        node.count++;
        node.documentIds.push(recordId);
        const parent = tagMap.get(`tag_L1_${l1}`);
        if (parent && !parent.children.includes(l2Id)) parent.children.push(l2Id);
      }

      // L3 tag
      if (l3 && l2 && l1) {
        const l3Id = `tag_L3_${l1}_${l2}_${l3}`;
        docTags.push(l3Id);
        if (!tagMap.has(l3Id)) {
          tagMap.set(l3Id, { id: l3Id, name: l3, level: 'L3', count: 0, documentIds: [], children: [], parentId: `tag_L2_${l1}_${l2}`, x: 0, y: 0 });
        }
        const node = tagMap.get(l3Id)!;
        node.count++;
        node.documentIds.push(recordId);
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

    // ====== Layout: Tree-based concentric ======
    const canvasW = 1200;
    const canvasH = 900;
    const cx = canvasW / 2;
    const cy = canvasH / 2;

    const l1Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L1');
    const l2Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L2');
    const l3Nodes = Array.from(tagMap.values()).filter(n => n.level === 'L3');

    // L1: spread around center
    const l1Radius = Math.min(canvasW, canvasH) * 0.18;
    l1Nodes.forEach((node, i) => {
      const angle = (i / Math.max(l1Nodes.length, 1)) * 2 * Math.PI - Math.PI / 2;
      node.x = Math.round((cx + l1Radius * Math.cos(angle)) * 100) / 100;
      node.y = Math.round((cy + l1Radius * Math.sin(angle)) * 100) / 100;
    });

    // L2: circle around parent L1
    const l2Radius = 100;
    l2Nodes.forEach(node => {
      if (node.parentId) {
        const parent = tagMap.get(node.parentId);
        if (parent) {
          const siblings = parent.children;
          const idx = siblings.indexOf(node.id);
          const totalSiblings = Math.max(siblings.length, 1);
          const angle = (idx / totalSiblings) * 2 * Math.PI - Math.PI / 2;
          node.x = Math.round((parent.x + l2Radius * Math.cos(angle)) * 100) / 100;
          node.y = Math.round((parent.y + l2Radius * Math.sin(angle)) * 100) / 100;
        } else {
          node.x = cx + (Math.random() - 0.5) * 200;
          node.y = cy + (Math.random() - 0.5) * 200;
        }
      }
    });

    // L3: circle around parent L2
    const l3Radius = 70;
    l3Nodes.forEach(node => {
      if (node.parentId) {
        const parent = tagMap.get(node.parentId);
        if (parent) {
          const siblings = parent.children;
          const idx = siblings.indexOf(node.id);
          const totalSiblings = Math.max(siblings.length, 1);
          const angle = (idx / totalSiblings) * 2 * Math.PI - Math.PI / 2;
          node.x = Math.round((parent.x + l3Radius * Math.cos(angle)) * 100) / 100;
          node.y = Math.round((parent.y + l3Radius * Math.sin(angle)) * 100) / 100;
        }
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

    // ====== Domain circles (based on L1 tags) ======
    const domains = l1Nodes.map(node => ({
      name: node.name,
      cx: node.x,
      cy: node.y,
      r: 160,
      count: node.count,
    }));

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

export default router;
