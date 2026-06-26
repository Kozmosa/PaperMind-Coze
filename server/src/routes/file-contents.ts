import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// GET /api/v1/file-contents/:draftId
router.get('/:draftId', async (req: Request, res: Response) => {
  try {
    const draftId = parseInt(req.params.draftId as string);
    if (isNaN(draftId)) {
      return res.status(400).json({ error: '无效的 draftId' });
    }

    const { data, error } = await client
      .from('file_contents')
      .select('*')
      .eq('draft_id', draftId)
      .order('page_number', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ data: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/file-contents/search - 全文检索
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { keyword, draft_ids } = req.body;
    if (!keyword) {
      return res.status(400).json({ error: '缺少 keyword 参数' });
    }

    let query = client
      .from('file_contents')
      .select('*, draft_pool(file_url, file_name)')
      .ilike('extracted_text', `%${keyword}%`)
      .limit(10);

    if (draft_ids && Array.isArray(draft_ids) && draft_ids.length > 0) {
      query = client
        .from('file_contents')
        .select('*, draft_pool(file_url, file_name)')
        .in('draft_id', draft_ids)
        .ilike('extracted_text', `%${keyword}%`)
        .limit(10);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // 提取摘要片段
    const results = (data || []).map((item: any) => {
      const text = item.extracted_text || '';
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
      let snippet = text.slice(0, 200);
      if (idx > 0) {
        const start = Math.max(0, idx - 80);
        const end = Math.min(text.length, idx + 120);
        snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
      } else {
        snippet = text.slice(0, 200) + (text.length > 200 ? '...' : '');
      }
      return {
        draft_id: item.draft_id,
        page_number: item.page_number,
        snippet,
        file_url: item.draft_pool?.file_url,
        file_name: item.draft_pool?.file_name,
      };
    });

    res.json({ data: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
