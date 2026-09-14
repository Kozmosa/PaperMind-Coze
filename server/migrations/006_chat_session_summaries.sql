-- ===========================================
-- 「我明白了」升级为会话级总结记录（覆盖制）：
-- 每次点击由 tutor 对完整对话做结构化总结，同一会话只保留一条（覆盖更新），
-- 反思助手消费提炼后的认知信号而非原始对话全文。
-- 幂等，可重复执行。
-- ===========================================

ALTER TABLE public.problem_solving_logs
    ADD COLUMN IF NOT EXISTS chat_session_id TEXT,
    ADD COLUMN IF NOT EXISTS confusions TEXT[],
    ADD COLUMN IF NOT EXISTS mastered TEXT[],
    ADD COLUMN IF NOT EXISTS question_patterns TEXT[],
    ADD COLUMN IF NOT EXISTS open_questions TEXT[],
    ADD COLUMN IF NOT EXISTS knowledge_links TEXT[],
    ADD COLUMN IF NOT EXISTS depth_score INT;

-- 覆盖制：同一用户同一会话唯一一条总结记录
CREATE UNIQUE INDEX IF NOT EXISTS idx_psl_user_session
    ON public.problem_solving_logs (user_id, chat_session_id)
    WHERE chat_session_id IS NOT NULL;
