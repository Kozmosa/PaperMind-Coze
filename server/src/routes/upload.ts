import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { extractText } from '../utils/extract-text.js';

const router = Router();
const client = getSupabaseClient();

function decodeOriginalName(name: string): string {
  try {
    const repaired = Buffer.from(name, 'latin1').toString('utf8');
    // 如果已经是合法 utf-8 字符串（无替换字符），用修复版本；否则保留原值
    if (repaired && !repaired.includes('�')) return repaired;
  } catch {}
  return name;
}

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const decoded = decodeOriginalName(file.originalname || '');
    const ext = path.extname(decoded);
    const base =
      path
        .basename(decoded, ext)
        .replace(/[^\w\-一-鿿]/g, '_')
        .slice(0, 40) || 'file';
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${stamp}__${base}${ext}`);
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
    const allowedExts = [
      '.md',
      '.docx',
      '.doc',
      '.pptx',
      '.ppt',
      '.pdf',
      '.txt',
      '.csv',
      '.xlsx',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
    ];
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
      const originalName = decodeOriginalName(file.originalname || 'file');
      const filePath = path.join(UPLOAD_DIR, file.filename);
      const extracted = await extractText(filePath, file.mimetype, originalName);

      const userId = (req as any).userId || 'guest';
      const { data: draft, error: draftError } = await client
        .from('draft_pool')
        .insert({
          content: extracted.text || `[文件内容已提取，共 ${extracted.pageCount || '?'} 页]`,
          file_url: `/uploads/${file.filename}`,
          file_name: originalName,
          status: extracted.text ? 'processed' : 'unprocessed',
          user_id: userId,
        })
        .select()
        .single();

      if (draftError) {
        console.error('[upload] Failed to create draft:', draftError);
      } else if (draft && extracted.text) {
        if (extracted.pageCount && extracted.pageCount > 1) {
          const pages = extracted.text.split(/\n\n+/).filter(Boolean);
          for (let i = 0; i < Math.min(pages.length, extracted.pageCount); i++) {
            await client.from('file_contents').insert({
              draft_id: draft.id,
              extracted_text: pages[i]?.slice(0, 10000),
              page_number: i + 1,
            });
          }
        } else {
          await client.from('file_contents').insert({
            draft_id: draft.id,
            extracted_text: extracted.text.slice(0, 50000),
            // 单页文件统一写第 1 页，保证 file_content 引用卡片有页码 badge（issue #5）
            page_number: 1,
          });
        }
      }

      // ====== 同步触发知识分类（不再 fire-and-forget）======
      // 可选表单字段：title（自定义标题）、logical_path（用户选择的文件夹路径，JSON 字符串数组）
      // 由客户端直接随上传提交，避免上传后再 POST /materials 造成重复记录（issue #7）
      const title = req.body?.title;
      const logicalPath = req.body?.logical_path;
      let materialId: string | null = null;
      let classification: any = null;
      try {
        const materialInsert: Record<string, any> = {
          user_id: userId,
          name: title || originalName,
          file_path: `/uploads/${file.filename}`,
          file_type: file.mimetype,
          tags: [],
          ai_processed: false,
          viewed_after_process: false,
        };
        if (logicalPath) materialInsert.logical_path = logicalPath;

        const { data: material, error: matErr } = await client
          .from('materials')
          .insert(materialInsert)
          .select()
          .single();
        if (matErr) throw new Error(matErr.message);
        materialId = material?.id || null;

        // 自调 process-content：直接走本进程的 knowledge-builder handler，避免 HTTP 自调
        // 带来的端口 / 用户上下文传递问题
        const mod: any = await import('./knowledge-builder.js');
        const handleProcess = mod.handleProcessContent;
        if (typeof handleProcess !== 'function') {
          throw new Error('knowledge-builder handler 未导出');
        }
        const fakeReq: any = {
          body: { type: 'material', id: materialId },
          userId,
        };
        let clsResult: any = null;
        let clsError: any = null;
        const fakeRes: any = {
          json: (v: any) => {
            clsResult = v;
            return fakeRes;
          },
          status: (code: number) => {
            fakeRes._status = code;
            return fakeRes;
          },
          _status: 200,
        };
        try {
          await handleProcess(fakeReq, fakeRes);
        } catch (e: any) {
          clsError = e;
        }
        if (clsError || fakeRes._status >= 400) {
          throw new Error(clsError?.message || '分类 handler 返回 ' + fakeRes._status);
        }
        classification = clsResult;
      } catch (clsErr: any) {
        console.error('[upload] classification error:', clsErr.message);
        classification = { error: clsErr.message };
        // 标记失败：保持 ai_processed=false，批次接口/重新分析可重试（issue #7 Task 2）
        if (materialId) {
          try {
            await client
              .from('materials')
              .update({ process_status: 'failed' })
              .eq('id', materialId);
          } catch {}
        }
      }

      res.json({
        fileKey: file.filename,
        fileUrl: `/uploads/${file.filename}`,
        fileName: originalName,
        mimeType: file.mimetype,
        draftId: draft?.id,
        materialId,
        extracted: !!extracted.text,
        classification,
      });
    } catch (err: any) {
      console.error('[upload] Error:', err);
      res.json({
        fileKey: file.filename,
        fileUrl: `/uploads/${file.filename}`,
        fileName: decodeOriginalName(file.originalname || 'file'),
        draftId: null,
        extracted: false,
      });
    }
  });
});

export default router;
