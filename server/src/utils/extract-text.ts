/**
 * 文件文本提取工具
 * 支持: PDF, DOCX, PPTX, XLSX, TXT, MD, CSV
 * 不支持: .doc/.ppt 旧版二进制格式（上传入口 fileFilter 已拦截）、图片（无 OCR，按图片附件处理）
 */

import * as fs from 'fs';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';
import { VISION_CONFIG } from '../config/ai.js';

export interface ExtractedContent {
  text: string;
  pageCount?: number;
}

// 可读性判定：过滤扫描件/嵌入字体损坏产生的乱码（CJK 占比极低且 ASCII 占比极低）
export function isReadableText(text: string): boolean {
  if (!text || text.length < 5) return false;

  // Count CJK characters specifically (for Chinese academic content)
  const cjk = text.match(/[一-鿿]/g);
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
  const readable = text.match(
    /[一-鿿　-〿＀-￯a-zA-Z0-9\s.,;:!?()[\]\]{}\-+=_"'<>/\\@#$%^&*]/g,
  );
  if (!readable) return false;
  return readable.length / text.length > 0.15;
}

// 乱码字形检测：嵌入字体损坏时 pdf-parse 输出同一字符连续重复的碎片
// （如 "u u u H H H" 三连重复），真实文本中相邻同字符占比极低
export function looksLikeBrokenGlyphs(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 30) return false;
  let repeats = 0;
  for (let i = 1; i < compact.length; i++) {
    if (compact[i] === compact[i - 1]) repeats++;
  }
  return repeats / compact.length > 0.15;
}

// pdf-parse v2.4.5 uses class-based API: new PDFParse({ data: buffer })
async function getPdfParser() {
  const { PDFParse } = await import('pdf-parse');
  return PDFParse;
}

/**
 * 提取文本内容
 */
export async function extractText(
  filePath: string,
  mimeType: string,
  fileName: string,
): Promise<ExtractedContent> {
  try {
    // 图片无 OCR：学习纪要图片附件会走到这里，返回空文本由上传层按「图片附件」诚实处理
    if (mimeType.startsWith('image/')) {
      return { text: '', pageCount: 0 };
    }

    // PDF
    if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
      return extractPdf(filePath);
    }

    // DOCX
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      fileName.endsWith('.docx')
    ) {
      return extractDocx(filePath);
    }

    // PPTX
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      fileName.endsWith('.pptx')
    ) {
      return extractPptx(filePath);
    }

    // TXT / MD / CSV
    if (
      mimeType === 'text/plain' ||
      mimeType === 'text/markdown' ||
      fileName.endsWith('.txt') ||
      fileName.endsWith('.md') ||
      fileName.endsWith('.csv')
    ) {
      const text = fs.readFileSync(filePath, 'utf-8');
      return { text: text.slice(0, 50000) };
    }

    // XLSX
    if (
      fileName.endsWith('.xlsx') ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      return extractXlsx(filePath);
    }

    // .ppt / .doc 旧版二进制格式：无提取实现，返回标记文本供分类链路识别
    // （knowledge-builder 的占位检测会走 degraded 路径，用户看到明确提示而非静默失败）
    if (mimeType === 'application/vnd.ms-powerpoint' || fileName.endsWith('.ppt')) {
      return {
        text: '[旧版PPT二进制格式，无法自动提取，请转存为 .pptx 后重新上传]',
        pageCount: 0,
      };
    }
    if (mimeType === 'application/msword' || fileName.endsWith('.doc')) {
      return {
        text: '[旧版Word二进制格式，无法自动提取，请转存为 .docx 后重新上传]',
        pageCount: 0,
      };
    }

    return { text: '' };
  } catch (err) {
    console.error('[extractText] Error:', err);
    return { text: '' };
  }
}

// 清理提取文本：课件页脚标记（"-- 2 of 252 --"）、连续重复页眉行、多余空行、CRLF 归一化
function cleanExtractedText(text: string): string {
  const t = text
    .replace(/\r\n/g, '\n')
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  const out: string[] = [];
  for (const line of t.split('\n')) {
    if (out.length > 0 && out[out.length - 1] === line && line.trim().length > 0) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

async function extractPdf(filePath: string): Promise<ExtractedContent> {
  try {
    const PDFParse = await getPdfParser();
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    const raw = await parser.getText();
    const data: { text: string; numpages?: number } =
      typeof raw === 'string' ? { text: raw, numpages: undefined } : raw;
    const text = cleanExtractedText(data.text || '');
    // 扫描件/乱码：pdf-parse 提取为空、过短、不可读或字形破碎 → 视觉模型 OCR 兜底
    if (text.length < 50 || !isReadableText(text) || looksLikeBrokenGlyphs(text)) {
      const vision = await extractPdfWithVision(filePath);
      if (vision.text) {
        return { text: vision.text, pageCount: vision.pageCount || data.numpages || 0 };
      }
    }
    return {
      text,
      pageCount: data.numpages || 0,
    };
  } catch (err) {
    console.error('[extractPdf] Error:', err);
    return { text: '' };
  }
}

// 视觉 OCR 兜底（扫描件）：渲染前 N 页为图片交给视觉模型识别，逐页 \f 拼接
// 走 OpenAI 兼容端点（DeepSeek 的 Anthropic 端点不转发图片块，实测 OpenAI 格式可用）
async function extractPdfWithVision(filePath: string, maxPages = 5): Promise<ExtractedContent> {
  if (!VISION_CONFIG.apiKey) return { text: '' };
  try {
    const mupdf = await import('mupdf');
    const data = fs.readFileSync(filePath);
    const doc = mupdf.Document.openDocument(data, 'application/pdf');
    const total = Math.min(doc.countPages(), maxPages);
    const texts: string[] = [];
    for (let i = 0; i < total; i++) {
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(1.5, 1.5),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      const b64 = Buffer.from(pixmap.asPNG()).toString('base64');
      const resp = await fetch(`${VISION_CONFIG.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VISION_CONFIG.apiKey}`,
        },
        body: JSON.stringify({
          model: VISION_CONFIG.model,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                {
                  type: 'text',
                  text: '请识别这张课件页面的全部文字内容（标题、正文；公式用 LaTeX 表达），按原文顺序输出，不要添加解释或客套话。',
                },
              ],
            },
          ],
        }),
      });
      const j: any = await resp.json().catch(() => ({}));
      if (j.error) {
        console.error('[extractPdfWithVision] API error:', JSON.stringify(j.error).slice(0, 150));
        continue;
      }
      const t = (j.choices?.[0]?.message?.content || '').trim();
      if (t && !t.includes('无法') && !t.includes('Unsupported')) texts.push(t);
    }
    return texts.length > 0 ? { text: texts.join('\f'), pageCount: texts.length } : { text: '' };
  } catch (e) {
    console.error('[extractPdfWithVision] Error:', (e as any)?.message);
    return { text: '' };
  }
}

async function extractDocx(filePath: string): Promise<ExtractedContent> {
  try {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return { text: value || '' };
  } catch (err) {
    console.error('[extractDocx] Error:', err);
    return { text: '' };
  }
}

async function extractPptx(filePath: string): Promise<ExtractedContent> {
  try {
    const zip = new AdmZip(filePath);
    const slides = zip
      .getEntries()
      .filter(
        (e: any) => e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml'),
      );
    const texts: string[] = [];
    for (const slide of slides) {
      const content = slide.getData().toString('utf-8');
      const matches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
      const slideText = matches
        .map((m: string) => m.replace(/<\/?a:t>/g, ''))
        .join(' ')
        .trim();
      if (slideText) texts.push(slideText);
    }
    // 用换页符 \f 连接各页幻灯片，file-content 路由可按 \f 拆出逐页文本（与 PDF 分页同路径）
    return { text: texts.join('\f'), pageCount: slides.length };
  } catch (err) {
    console.error('[extractPptx] Error:', err);
    return { text: '' };
  }
}

async function extractXlsx(filePath: string): Promise<ExtractedContent> {
  try {
    const zip = new AdmZip(filePath);
    const sheets = zip
      .getEntries()
      .filter(
        (e: any) => e.entryName.startsWith('xl/worksheets/sheet') && e.entryName.endsWith('.xml'),
      );
    const texts: string[] = [];
    for (const sheet of sheets) {
      const content = sheet.getData().toString('utf-8');
      const matches = content.match(/<c[^>]*r="([A-Z]+\d+)"[^>]*>.*?<v>([^<]*)<\/v>/g) || [];
      const sheetText = matches
        .map((m: string) => m.replace(/<[^>]*>/g, ''))
        .join(' ')
        .trim();
      if (sheetText) texts.push(sheetText);
    }
    return { text: texts.join('\n'), pageCount: sheets.length };
  } catch (err) {
    console.error('[extractXlsx] Error:', err);
    return { text: '' };
  }
}
