import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { anthropic, DEFAULT_MODEL } from '../config/ai.js';

const router = Router();
const client = getSupabaseClient();

// 会话总结 prompt：把完整对话提炼为反思引擎可统计的认知信号
function buildSessionSummaryPrompt(messages: { role: string; content: string }[]): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '学生' : '导师'}：${String(m.content || '').slice(0, 3000)}`)
    .join('\n');
  return `你是学习分析专家。以下是一名学生与智能导师的一段完整对话。请把这段对话总结为一份学习认知快照，严格输出 JSON（不要 markdown 代码块）：

对话：
${transcript}

输出 JSON 字段要求：
{
  "question": "学生本次对话的核心问题（一句概括，50字内）",
  "summary": "200-300字总结：问题脉络（问过什么、按什么顺序、如何推进）+ 认知变化（从什么状态到什么状态）",
  "mastered": ["学生已掌握/理解正确的概念（最多5个，没有则空数组）"],
  "confusions": ["学生暴露出的混淆点/错误理解/薄弱环节（最多5个）"],
  "question_patterns": ["提问模式标签，从以下类型选1-3个：概念辨析型、公式推导型、错题复盘型、应用场景型、发散延伸型、记忆巩固型"],
  "open_questions": ["对话结束时仍未解决的疑问（没有则空数组）"],
  "knowledge_links": ["涉及的学科/领域标签（如：复分析、数理统计）"],
  "depth_score": 1到5的整数，评估追问深度（1=浅尝辄止，5=追根究底）
}`;
}

// POST /summarize — 「我明白了」升级版：完整对话 → tutor 总结 → 按会话覆盖入库
router.post('/summarize', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { chat_session_id, messages } = req.body;
    if (!chat_session_id || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '缺少 chat_session_id 或 messages' });
    }

    // 1) tutor 对完整对话做结构化总结（思考模型，无正文时升档重试）
    const prompt = buildSessionSummaryPrompt(messages);
    let content = '';
    for (const budget of [4096, 16384]) {
      const resp = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: budget,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      });
      content = resp.content
        .filter((x: any) => x.type === 'text')
        .map((x: any) => x.text)
        .join('')
        .trim();
      if (content) break;
      console.warn('[psl-summarize] 无正文输出，升档重试');
    }
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('总结响应无 JSON');
    const parsed = JSON.parse(m[0]);
    const arr = (v: any) => (Array.isArray(v) ? v.map((x: any) => String(x).slice(0, 200)).slice(0, 5) : []);
    const payload = {
      user_id: userId,
      chat_session_id,
      question: String(parsed.question || '').slice(0, 200),
      answer: String(parsed.summary || '').slice(0, 4000),
      mastered: arr(parsed.mastered),
      confusions: arr(parsed.confusions),
      question_patterns: arr(parsed.question_patterns),
      open_questions: arr(parsed.open_questions),
      knowledge_links: arr(parsed.knowledge_links),
      depth_score: Math.max(1, Math.min(5, parseInt(parsed.depth_score) || 1)),
    };

    // 2) 覆盖制：同一会话只保留一条（唯一索引兜底冲突则更新）
    const { data: existing } = await client
      .from('problem_solving_logs')
      .select('id')
      .eq('user_id', userId)
      .eq('chat_session_id', chat_session_id)
      .limit(1);
    let data: any;
    if (existing && existing.length > 0) {
      const upd = await client
        .from('problem_solving_logs')
        .update(payload)
        .eq('id', existing[0].id)
        .select()
        .single();
      if (upd.error) throw new Error(upd.error.message);
      data = upd.data;
    } else {
      const ins = await client
        .from('problem_solving_logs')
        .insert(payload)
        .select()
        .single();
      if (ins.error) throw new Error(ins.error.message);
      data = ins.data;
    }
    res.json({ data, overwritten: !!existing?.length });
  } catch (err: any) {
    console.error('[psl-summarize] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
