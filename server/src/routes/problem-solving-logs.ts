import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有问题解答日志
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('problem_solving_logs').select('*').order('solved_at', { ascending: false });
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

// 创建问题解答日志
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { question, answer, steps, related_knowledge_node_ids, related_draft_ids, citation_snippets } = req.body;

    const { data, error } = await client
      .from('problem_solving_logs')
      .insert({
        user_id: userId,
        question: question || '',
        answer: answer || '',
        steps: steps || '',
        related_knowledge_node_ids: related_knowledge_node_ids || [],
        related_draft_ids: related_draft_ids || [],
        citation_snippets: citation_snippets || [],
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 获取统计数据（按时间段）
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const days = parseInt(req.query.days as string) || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = client
      .from('problem_solving_logs')
      .select('solved_at')
      .gte('solved_at', startDate);
    if (userId && userId !== 'guest') {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // 按天统计
    const stats: Record<string, number> = {};
    data?.forEach((log: any) => {
      const date = new Date(log.solved_at).toISOString().split('T')[0];
      stats[date] = (stats[date] || 0) + 1;
    });

    res.json({ data: { total: data?.length || 0, daily: stats } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
