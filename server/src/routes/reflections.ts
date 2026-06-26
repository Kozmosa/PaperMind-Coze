import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有反思（支持用户隔离）
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client.from('reflections').select('*').order('created_at', { ascending: false });
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

// 获取单个反思
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('reflections')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '反思不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建反思
router.post('/', async (req: Request, res: Response) => {
  try {
    const { learning_behavior, challenge_report, thinking_pattern, suggestion, period } = req.body;
    if (!period) return res.status(400).json({ error: '时间段不能为空' });
    const userId = (req as any).userId || 'guest';

    const { data, error } = await client
      .from('reflections')
      .insert({
        learning_behavior: learning_behavior || null,
        challenge_report: challenge_report || null,
        thinking_pattern: thinking_pattern || null,
        suggestion: suggestion || null,
        period,
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

export default router;