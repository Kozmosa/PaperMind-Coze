import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();
const client = getSupabaseClient();

// 获取当前用户的笔记风格偏好
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId || userId === 'guest') {
      return res.json({ data: null });
    }

    const { data, error } = await client
      .from('papernote_style')
      .select('*')
      .eq('user_id', userId)
      .limit(1);
    if (error) throw new Error(error.message);
    res.json({ data: data?.[0] || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 创建或更新当前用户的笔记风格偏好
router.put('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId || userId === 'guest') {
      return res.status(401).json({ error: '需要登录' });
    }

    const { general_preference, subject_preferences } = req.body;
    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (general_preference !== undefined) updateData.general_preference = general_preference;
    if (subject_preferences !== undefined) updateData.subject_preferences = subject_preferences;

    // 查找当前用户的已有记录
    const { data: existing } = await client
      .from('papernote_style')
      .select('id')
      .eq('user_id', userId)
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
          user_id: userId,
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

// 从修正指令中提取偏好并合并存储
router.post('/extract', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId || userId === 'guest') {
      return res.status(401).json({ error: '需要登录' });
    }

    const { refinementPrompt } = req.body;
    if (!refinementPrompt) {
      return res.status(400).json({ error: '缺少修正指令' });
    }

    // 提取偏好关键词
    const extractedPrefs: Record<string, any> = {};
    const prompt = refinementPrompt.toLowerCase();
    if (prompt.includes('详细') || prompt.includes('展开') || prompt.includes('更多')) extractedPrefs.detail_level = 'high';
    if (prompt.includes('简洁') || prompt.includes('简短') || prompt.includes('概括')) extractedPrefs.detail_level = 'concise';
    if (prompt.includes('表格') || prompt.includes('对比')) extractedPrefs.prefer_tables = true;
    if (prompt.includes('例子') || prompt.includes('示例') || prompt.includes('举例')) extractedPrefs.prefer_examples = true;
    if (prompt.includes('重点') || prompt.includes('突出') || prompt.includes('强调')) extractedPrefs.emphasize_keypoints = true;
    if (prompt.includes('通俗') || prompt.includes('简单') || prompt.includes('易懂')) extractedPrefs.language_style = 'plain';

    // 合并到已有偏好
    const { data: existing } = await client
      .from('papernote_style')
      .select('*')
      .eq('user_id', userId)
      .limit(1);

    const existingPrefs = (existing && existing.length > 0 && existing[0].subject_preferences)
      ? existing[0].subject_preferences
      : {};

    const mergedPrefs = { ...existingPrefs, ...extractedPrefs };

    if (existing && existing.length > 0) {
      await client
        .from('papernote_style')
        .update({
          subject_preferences: mergedPrefs,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id);
    } else {
      await client
        .from('papernote_style')
        .insert({
          user_id: userId,
          subject_preferences: mergedPrefs,
        });
    }

    res.json({ data: { extracted: extractedPrefs, merged: mergedPrefs } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;