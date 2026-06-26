import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有草稿（支持用户隔离）
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('draft_pool').select('*').order('created_at', { ascending: false });
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

// 创建草稿
router.post('/', async (req: Request, res: Response) => {
  try {
    const { content, file_url, file_name } = req.body;
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    const userId = (req as any).userId || 'guest';

    const { data, error } = await client
      .from('draft_pool')
      .insert({
        content,
        file_url: file_url || null,
        file_name: file_name || null,
        status: 'unprocessed',
        notification_sent: false,
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

// 更新草稿状态
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { status, notification_sent } = req.body;
    const updateData: Record<string, any> = {};
    if (status) updateData.status = status;
    if (notification_sent !== undefined) updateData.notification_sent = notification_sent;

    const { data, error } = await client
      .from('draft_pool')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '草稿不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 删除草稿
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('draft_pool')
      .delete()
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '草稿不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;