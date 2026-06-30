import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { extractText } from '../utils/extract-text.js';

const router = Router();
const client = getSupabaseClient();

// 确保上传目录存在
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      'text/markdown',
      'text/plain',
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.md', '.docx', '.doc', '.pptx', '.ppt', '.pdf', '.txt', '.csv', '.xlsx', '.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，仅支持：markdown, docx, pptx, pdf, txt, csv, xlsx, 图片'));
    }
  },
});

// POST /api/v1/upload
router.post('/', async (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `文件上传错误: ${err.message}` });
      }
      return res.status(400).json({ error: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    try {
      // 异步提取文本内容
      const filePath = path.join(UPLOAD_DIR, file.filename);
      const extracted = await extractText(filePath, file.mimetype, file.originalname);

      // 保存到 draft_pool（创建草稿记录）
      const userId = (req as any).userId || 'guest';
      const { data: draft, error: draftError } = await client
        .from('draft_pool')
        .insert({
          content: extracted.text || `[文件内容已提取，共 ${extracted.pageCount || '?'} 页]`,
          file_url: `/uploads/${file.filename}`,
          file_name: file.originalname,
          status: extracted.text ? 'processed' : 'unprocessed',
          user_id: userId,
        })
        .select()
        .single();

      if (draftError) {
        console.error('[upload] Failed to create draft:', draftError);
      } else if (draft && extracted.text) {
        // 将提取的文本存入 file_contents 表
        if (extracted.pageCount && extracted.pageCount > 1) {
          // PDF 多页：按页存储
          const pages = extracted.text.split(/\n\n+/).filter(Boolean);
          for (let i = 0; i < Math.min(pages.length, extracted.pageCount); i++) {
            await client.from('file_contents').insert({
              draft_id: draft.id,
              extracted_text: pages[i]?.slice(0, 10000),
              page_number: i + 1,
            });
          }
        } else {
          // 单页或非 PDF
          await client.from('file_contents').insert({
            draft_id: draft.id,
            extracted_text: extracted.text.slice(0, 50000),
            page_number: null,
          });
        }
      }

      res.json({
        fileKey: file.filename,
        fileUrl: `/uploads/${file.filename}`,
        fileName: file.originalname,
        mimeType: file.mimetype,
        draftId: draft?.id,
        extracted: !!extracted.text,
      });
    } catch (err: any) {
      console.error('[upload] Error:', err);
      res.json({
        fileKey: file.filename,
        fileUrl: `/uploads/${file.filename}`,
        fileName: file.originalname,
        draftId: null,
        extracted: false,
      });
    }
  });
});

export default router;
