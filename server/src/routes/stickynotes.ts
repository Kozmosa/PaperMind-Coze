import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取便利贴列表（支持按可见范围过滤）
router.get('/', async (req: Request, res: Response) => {
  try {
    const { visibility, search } = req.query;
    let query = client
      .from('stickynotes')
      .select('*')
      .order('created_at', { ascending: false });

    if (visibility) {
      query = query.eq('visibility', visibility);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建便利贴
router.post('/', async (req: Request, res: Response) => {
  try {
    const { papercore, original_material, visibility, author_name } = req.body;
    if (!papercore) return res.status(400).json({ error: '内容不能为空' });

    const { data, error } = await client
      .from('stickynotes')
      .insert({
        papercore,
        original_material: original_material || null,
        visibility: visibility || 'public',
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

// 删除便利贴
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('stickynotes')
      .delete()
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: '便利贴不存在' });
    res.json({ data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;