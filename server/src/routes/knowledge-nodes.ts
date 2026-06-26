import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有知识节点（支持用户隔离）
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('knowledge_nodes').select('*').order('created_at', { ascending: false });
    // 只对已登录用户过滤数据，guest 看到全部（演示用）
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

// 获取单个知识节点
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('knowledge_nodes')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '节点不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建知识节点
router.post('/', async (req: Request, res: Response) => {
  try {
    const { papercore, short_name, original_file, tags, relations, attached_draft_ids, parent_id } = req.body;
    if (!papercore) return res.status(400).json({ error: 'Papercore 不能为空' });
    const userId = (req as any).userId || 'guest';

    const { data, error } = await client
      .from('knowledge_nodes')
      .insert({
        papercore,
        short_name: short_name || '',
        original_file: original_file || null,
        tags: tags || [],
        relations: relations || {},
        attached_draft_ids: attached_draft_ids || [],
        parent_id: parent_id || null,
        user_id: userId,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 更新知识节点
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { papercore, short_name, original_file, tags, relations, attached_draft_ids, parent_id } = req.body;
    const updateData: Record<string, any> = {};
    if (papercore !== undefined) updateData.papercore = papercore;
    if (short_name !== undefined) updateData.short_name = short_name;
    if (original_file !== undefined) updateData.original_file = original_file;
    if (tags !== undefined) updateData.tags = tags;
    if (relations !== undefined) updateData.relations = relations;
    if (attached_draft_ids !== undefined) updateData.attached_draft_ids = attached_draft_ids;
    if (parent_id !== undefined) updateData.parent_id = parent_id;
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await client
      .from('knowledge_nodes')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '节点不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 删除知识节点
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('knowledge_nodes')
      .delete()
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '节点不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;