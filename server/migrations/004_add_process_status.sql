-- ===========================================
-- 分类处理状态机（issue #7 Task 2）
-- process_status: pending（未处理）/ processed（成功）/ failed（失败，可重试）
-- 分类失败不再伪装成 ai_processed=true，批次接口可自动重试。
-- 幂等，可重复执行。运行方式：Supabase SQL Editor → 粘贴 → Run
-- ===========================================

ALTER TABLE public.materials
    ADD COLUMN IF NOT EXISTS process_status TEXT DEFAULT 'pending';

ALTER TABLE public.study_notes
    ADD COLUMN IF NOT EXISTS process_status TEXT DEFAULT 'pending';
