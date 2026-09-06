import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();

// POST /mark-viewed - mark a study note or material as viewed (clear red dot)
router.post('/mark-viewed', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const { type, id } = req.body;

    if (!type || !id) {
      return res.status(400).json({ error: 'type and id are required' });
    }

    if (type !== 'study_note' && type !== 'material') {
      return res.status(400).json({ error: 'type must be "study_note" or "material"' });
    }

    const table = type === 'study_note' ? 'study_notes' : 'materials';
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from(table)
      .update({ viewed_after_process: true })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);

    res.json({ success: true });
  } catch (err: any) {
    console.error('mark-viewed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /recent-records - get combined recent study notes and materials
router.get('/recent-records', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || 'guest';
    const supabase = getSupabaseClient();
    const perTableLimit = Math.min(parseInt(req.query.limit as string) || 50, 500);

    const [notesRes, materialsRes] = await Promise.all([
      supabase
        .from('study_notes')
        .select(
          'id, title, content, tags, logical_path, papercore, ai_processed, viewed_after_process, process_status, created_at, updated_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(perTableLimit),
      supabase
        .from('materials')
        .select(
          'id, name, tags, logical_path, papercore, ai_processed, viewed_after_process, process_status, created_at, updated_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(perTableLimit),
    ]);

    // process_status 由 migrations/004 引入，旧库缺列时降级为不带该列重查（无状态徽标）
    let notesData: any[] | null = notesRes.data;
    let notesError = notesRes.error;
    let materialsData: any[] | null = materialsRes.data;
    let materialsError = materialsRes.error;
    if (notesError && /process_status/.test(notesError.message)) {
      const retry = await supabase
        .from('study_notes')
        .select(
          'id, title, content, tags, logical_path, papercore, ai_processed, viewed_after_process, created_at, updated_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(perTableLimit);
      notesData = retry.data;
      notesError = retry.error;
    }
    if (materialsError && /process_status/.test(materialsError.message)) {
      const retry = await supabase
        .from('materials')
        .select(
          'id, name, tags, logical_path, papercore, ai_processed, viewed_after_process, created_at, updated_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(perTableLimit);
      materialsData = retry.data;
      materialsError = retry.error;
    }

    if (notesError) throw new Error(notesError.message);
    if (materialsError) throw new Error(materialsError.message);

    const notes = (notesData || []).map((n: any) => ({ ...n, record_type: 'study_note' }));
    const materials = (materialsData || []).map((m: any) => ({
      ...m,
      record_type: 'material',
    }));

    // Merge and sort by created_at descending
    const combined = [...notes, ...materials].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    res.json({ data: combined });
  } catch (err: any) {
    console.error('recent-records error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
