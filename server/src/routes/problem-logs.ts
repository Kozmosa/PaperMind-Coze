import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有问题日志
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('paper_problem_logs')
      .select('*')
      .order('created_at', { ascending: false });
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

    const { data, error } = await client
      .from('paper_problem_logs')
      .insert({
        problem,
        process: process || null,
        solution: solution || null,
        knowledge_node_ids: knowledge_node_ids || [],
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 删除问题日志
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('paper_problem_logs')
      .delete()
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '日志不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;