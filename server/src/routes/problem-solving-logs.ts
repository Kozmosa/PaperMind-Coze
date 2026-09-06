import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取所有问题解答日志
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    let query = client
      .from('problem_solving_logs')
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

// 创建问题解答日志
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const {
      question,
      answer,
      steps,
      related_knowledge_node_ids,
      related_draft_ids,
      citation_snippets,
    } = req.body;

    const payload = {
      user_id: userId,
      question: question || '',
      answer: answer || '',
      steps: steps || '',
      related_knowledge_node_ids: related_knowledge_node_ids || [],
      related_draft_ids: related_draft_ids || [],
      citation_snippets: citation_snippets || [],
    };

    let { data, error } = await client
      .from('problem_solving_logs')
      .insert(payload)
      .select()
      .single();

    // related_draft_ids 由 migrations/002 添加：未执行迁移的库返回 42703，
    // 降级去掉该列重试，避免「我明白了」写入断裂（与 issue #6 同源的缺列防御）
    if (error && (error.code === '42703' || /related_draft_ids/.test(error.message || ''))) {
      const rest = { ...payload };
      delete rest.related_draft_ids;
      const retry = await client.from('problem_solving_logs').insert(rest).select().single();
      data = retry.data;
      error = retry.error;
      console.warn(
        '[problem-solving-logs] related_draft_ids 列缺失，已降级写入（执行 migrations/002_add_related_draft_ids.sql 可恢复）',
      );
    }

    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 获取统计数据（按时间段，支持 endDate 锚定窗口终点，如反思报告生成时间）
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const days = parseInt(req.query.days as string) || 30;
    const endDateRaw = req.query.endDate as string | undefined;
    const end = endDateRaw ? new Date(endDateRaw) : new Date();
    const startDate = new Date(end.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const endISO = end.toISOString();

    let query = client
      .from('problem_solving_logs')
      .select('created_at')
      .gte('created_at', startDate)
      .lte('created_at', endISO);
    if (userId && userId !== 'guest') {
      query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // 按天统计
    const stats: Record<string, number> = {};
    data?.forEach((log: any) => {
      const date = new Date(log.created_at).toISOString().split('T')[0];
      stats[date] = (stats[date] || 0) + 1;
    });

    res.json({ data: { total: data?.length || 0, daily: stats } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
