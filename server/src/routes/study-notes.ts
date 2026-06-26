import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有学习纪要
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('study_notes').select('*').order('created_at', { ascending: false });
    if (userId && userId !== 'guest') {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建学习纪要
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { title, content, knowledge_node_id, tags, file_url, file_name, logical_path, blocks } = req.body;

    // 清理 tags 中的 # 前缀
    const cleanTags = (tags || []).map((t: string) => t.replace(/^#/, '').trim()).filter(Boolean);

    const insertData: Record<string, any> = {
      user_id: userId,
      title: title || '未命名纪要',
      content: content || '',
      tags: cleanTags,
      ai_processed: false,
      viewed_after_process: false,
    };
    // 仅当请求体中包含该字段时才写入（避免数据库列不存在时报错）
    if (knowledge_node_id !== undefined) insertData.knowledge_node_id = knowledge_node_id || null;
    if (file_url !== undefined) insertData.file_url = file_url || null;
    if (file_name !== undefined) insertData.file_name = file_name || null;
    if (logical_path !== undefined) insertData.logical_path = logical_path || null;
    if (blocks !== undefined) insertData.blocks = blocks;

    const { data, error } = await client
      .from('study_notes')
      .insert(insertData)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 更新学习纪要
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { title, content, knowledge_node_id, tags, processed, papercore, logical_path, ai_processed, viewed_after_process, blocks } = req.body;

    const cleanTags = (tags || []).map((t: string) => t.replace(/^#/, '').trim()).filter(Boolean);

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (knowledge_node_id !== undefined) updateData.knowledge_node_id = knowledge_node_id || null;
    if (tags !== undefined) updateData.tags = cleanTags;
    if (processed !== undefined) updateData.processed = processed;
    if (papercore !== undefined) updateData.papercore = papercore;
    if (logical_path !== undefined) updateData.logical_path = logical_path;
    if (ai_processed !== undefined) updateData.ai_processed = ai_processed;
    if (viewed_after_process !== undefined) updateData.viewed_after_process = viewed_after_process;
    if (blocks !== undefined) updateData.blocks = blocks;

    const { data, error } = await client
      .from('study_notes')
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

// 删除学习纪要
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { error } = await client
      .from('study_notes')
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
