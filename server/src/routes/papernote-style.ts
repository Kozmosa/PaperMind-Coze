import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取笔记风格（默认用户ID为 'default'）
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await client
      .from('papernote_style')
      .select('*')
      .limit(1);
    if (error) throw new Error(error.message);
    res.json({ data: data?.[0] || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建或更新笔记风格
router.put('/', async (req: Request, res: Response) => {
  try {
    const { general_preference, subject_preferences } = req.body;
    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (general_preference !== undefined) updateData.general_preference = general_preference;
    if (subject_preferences !== undefined) updateData.subject_preferences = subject_preferences;

    // 尝试查找已有记录
    const { data: existing } = await client
      .from('papernote_style')
      .select('id')
      .limit(1);

    let result;
    if (existing && existing.length > 0) {
      const { data, error } = await client
        .from('papernote_style')
        .update(updateData)
        .eq('id', existing[0].id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      result = data;
    } else {
      const { data, error } = await client
        .from('papernote_style')
        .insert({
          general_preference: general_preference || '',
          subject_preferences: subject_preferences || {},
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      result = data;
    }
    res.json({ data: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;