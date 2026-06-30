/**
 * 文件文本提取工具
 * 支持: PDF, DOCX, PPTX, TXT, MD, CSV
 */

// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import * as path from 'path';
import mammoth from 'mammoth';
// @ts-ignore
import AdmZip from 'adm-zip';

export interface ExtractedContent {
  text: string;
  pageCount?: number;
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
  fileName: string
): Promise<ExtractedContent> {
  try {
    // 图片文件暂不支持 OCR
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

    return { text: '' };
  } catch (err) {
    console.error('[extractText] Error:', err);
    return { text: '' };
  }
}

async function extractPdf(filePath: string): Promise<ExtractedContent> {
  try {
    const PDFParse = await getPdfParser();
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    const raw = await parser.getText();
    const data: { text: string; numpages?: number } =
      typeof raw === 'string' ? { text: raw, numpages: undefined } : raw;
    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
    };
  } catch (err) {
    console.error('[extractPdf] Error:', err);
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
    const slides = zip.getEntries().filter((e: any) => e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml'));
    const texts: string[] = [];
    for (const slide of slides) {
      const content = slide.getData().toString('utf-8');
      const matches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
      const slideText = matches.map((m: string) => m.replace(/<\/?a:t>/g, '')).join(' ').trim();
      if (slideText) texts.push(slideText);
    }
    return { text: texts.join('\n\n'), pageCount: slides.length };
  } catch (err) {
    console.error('[extractPptx] Error:', err);
    return { text: '' };
  }
}

async function extractXlsx(filePath: string): Promise<ExtractedContent> {
  try {
    const zip = new AdmZip(filePath);
    const sheets = zip.getEntries().filter((e: any) => e.entryName.startsWith('xl/worksheets/sheet') && e.entryName.endsWith('.xml'));
    const texts: string[] = [];
    for (const sheet of sheets) {
      const content = sheet.getData().toString('utf-8');
      const matches = content.match(/<c[^>]*r="([A-Z]+\d+)"[^>]*>.*?<v>([^<]*)<\/v>/g) || [];
      const sheetText = matches.map((m: string) => m.replace(/<[^>]*>/g, '')).join(' ').trim();
      if (sheetText) texts.push(sheetText);
    }
    return { text: texts.join('\n'), pageCount: sheets.length };
  } catch (err) {
    console.error('[extractXlsx] Error:', err);
    return { text: '' };
  }
}
