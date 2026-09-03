import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有问题日志（用户隔离）
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client
      .from('paper_problem_logs')
      .select('*')
      .order('created_at', { ascending: false });
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

// 创建问题日志
router.post('/', async (req: Request, res: Response) => {
  try {
    const { problem, process, solution, knowledge_node_ids } = req.body;
    if (!problem) return res.status(400).json({ error: '问题描述不能为空' });
    const userId = (req as any).userId || 'guest';

    const { data, error } = await client
      .from('paper_problem_logs')
      .insert({
        problem,
        process: process || null,
        solution: solution || null,
        knowledge_node_ids: knowledge_node_ids || [],
        // 落 user_id，反思数据源 #1 才能按用户采集到
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

// 删除问题日志（仅本人）
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('paper_problem_logs').delete().eq('id', req.params.id);
    if (userId && userId !== 'guest') {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query.select().single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '日志不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;