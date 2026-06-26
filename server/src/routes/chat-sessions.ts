import { Router } from 'express';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

const router = Router();

// Get all chat sessions for user
router.get('/', async (req, res) => {
  try {
    const userId = (req as any).userId || 'temp_user';
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data });
  } catch (e: any) {
    console.error('Failed to get chat sessions', e);
    res.status(500).json({ error: e.message });
  }
});

// Create new chat session
router.post('/', async (req, res) => {
  try {
    const userId = (req as any).userId || 'temp_user';
    const { title } = req.body;
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, title: title || '新对话' })
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (e: any) {
    console.error('Failed to create chat session', e);
    res.status(500).json({ error: e.message });
  }
});

// Get messages for a session
router.get('/:sessionId/messages', async (req, res) => {
  try {
    const userId = (req as any).userId || 'temp_user';
    const { sessionId } = req.params;
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ data });
  } catch (e: any) {
    console.error('Failed to get messages', e);
    res.status(500).json({ error: e.message });
  }
});

// Save a message to a session
router.post('/:sessionId/messages', async (req, res) => {
  try {
    const userId = (req as any).userId || 'temp_user';
    const { sessionId } = req.params;
    const { role, content, citations } = req.body;
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('chat_messages')
      .insert({ 
        session_id: sessionId, 
        user_id: userId, 
        role, 
        content, 
        citations: citations || [] 
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (e: any) {
    console.error('Failed to save message', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
