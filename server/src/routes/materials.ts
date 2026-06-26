import { Router } from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { extractText } from '../utils/extract-text.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有资料
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('materials').select('*').order('created_at', { ascending: false });
    if (userId) {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建资料记录（通过file-contents上传后的记录）
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { title, name, tags, logical_path, file_url, file_name, mime_type, file_size } = req.body;

    const cleanTags = (tags || []).map((t: string) => t.replace(/^#/, '').trim()).filter(Boolean);

    // Note: materials table uses file_path (not file_url), file_type (not mime_type)
    // file_name is stored in the name column (original filename)
    const insertData: Record<string, any> = {
      user_id: userId,
      name: name || title || '未命名资料',
      tags: cleanTags,
      ai_processed: false,
      viewed_after_process: false,
    };
    if (logical_path !== undefined) insertData.logical_path = logical_path || null;
    if (file_url) insertData.file_path = file_url;
    if (mime_type) insertData.file_type = mime_type;

    const { data, error } = await client
      .from('materials')
      .insert(insertData)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 更新资料
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { title, name, tags, processed, papercore, logical_path, ai_processed, viewed_after_process } = req.body;

    const cleanTags = (tags || []).map((t: string) => t.replace(/^#/, '').trim()).filter(Boolean);

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (title !== undefined) updateData.name = title;
    if (name !== undefined) updateData.name = name;
    if (tags !== undefined) updateData.tags = cleanTags;
    if (processed !== undefined) updateData.processed = processed;
    if (papercore !== undefined) updateData.papercore = papercore;
    if (logical_path !== undefined) updateData.logical_path = logical_path;
    if (ai_processed !== undefined) updateData.ai_processed = ai_processed;
    if (viewed_after_process !== undefined) updateData.viewed_after_process = viewed_after_process;

    const { data, error } = await client
      .from('materials')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 获取资料的文件内容（分页提取）
router.get('/:id/file-content', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { id } = req.params;

    // 1. 获取 material 记录
    const { data: material, error: fetchError } = await client
      .from('materials')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !material) {
      return res.status(404).json({ error: 'Material not found' });
    }

    // 2. 定位文件
    let filePath: string | null = null;
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const testDataDir = path.resolve(process.cwd(), '..', 'test_data', '学习资料');

    // 尝试 file_path → uploads 目录 (materials table uses file_path not file_url)
    const storedFilePath = material.file_path || material.file_url;
    if (!filePath && storedFilePath) {
      const urlPath = storedFilePath.replace(/^\/uploads\//, '');
      const candidate = path.join(uploadsDir, urlPath);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
      }
    }

    // 尝试 name → test_data 目录 (name stores original filename)
    if (!filePath && material.name) {
      const candidate = path.join(testDataDir, material.name);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
      }
    }

    // 模糊匹配
    if (!filePath && material.name) {
      const searchName = material.name;
      try {
        const files = fs.readdirSync(testDataDir);
        const match = files.find(f => f.includes(searchName) || searchName.includes(f));
        if (match) {
          filePath = path.join(testDataDir, match);
        }
      } catch {}
    }

    if (!filePath) {
      return res.status(404).json({ error: 'File not found on disk', name: material.name });
    }

    // 3. 提取文本
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
    const extracted = await extractText(filePath, mimeType, path.basename(filePath));

    // 4. 分页：按换页符 \f 拆分，否则按双换行分块
    const fullText = extracted.text || '';
    let pages: { page_number: number; text: string }[] = [];

    if (fullText.includes('\f')) {
      const splits = fullText.split('\f').filter(t => t.trim().length > 0);
      pages = splits.map((text, i) => ({ page_number: i + 1, text: text.trim() }));
    } else if (extracted.pageCount && extracted.pageCount > 1) {
      // 按页数大致均分
      const totalLen = fullText.length;
      const perPage = Math.ceil(totalLen / extracted.pageCount);
      for (let i = 0; i < extracted.pageCount; i++) {
        const start = i * perPage;
        const end = Math.min(start + perPage, totalLen);
        const chunk = fullText.slice(start, end).trim();
        if (chunk) pages.push({ page_number: i + 1, text: chunk });
      }
    } else {
      // 单页或无法分页
      pages = [{ page_number: 1, text: fullText }];
    }

    // 5. 构建可直接访问的文件 URL
    let viewUrl = '';
    const baseUrl = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 9091}`;
    if (filePath.includes('test_data')) {
      viewUrl = `${baseUrl}/test-data/${encodeURIComponent(path.basename(filePath))}`;
    } else if (filePath.includes('uploads')) {
      viewUrl = `${baseUrl}/uploads/${encodeURIComponent(path.basename(filePath))}`;
    }

    res.json({
      data: {
        pages,
        totalPages: pages.length,
        fileName: material.name || '未知文件',
        fileType: ext.replace('.', '').toUpperCase(),
        viewUrl,
      },
    });
  } catch (err: any) {
    console.error('[materials file-content] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 删除资料
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { error } = await client
      .from('materials')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
