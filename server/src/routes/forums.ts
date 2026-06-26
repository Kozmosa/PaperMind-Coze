import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// ===== 论坛 =====

// 获取所有论坛
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('forums')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建论坛
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, type, description } = req.body;
    if (!name || !type) return res.status(400).json({ error: '名称和类型不能为空' });

    const { data, error } = await client
      .from('forums')
      .insert({ name, type, description: description || null })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 论坛帖子 =====

// 获取某论坛的帖子
router.get('/:forumId/posts', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('forum_posts')
      .select('*')
      .eq('forum_id', req.params.forumId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建帖子
router.post('/:forumId/posts', async (req: Request, res: Response) => {
  try {
    const { title, content, author_name } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });

    const { data, error } = await client
      .from('forum_posts')
      .insert({
        forum_id: parseInt(String(req.params.forumId)),
        title,
        content,
        author_name: author_name || '匿名用户',
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;