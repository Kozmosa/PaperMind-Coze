-- ===========================================
-- 修复 problem_solving_logs 写入断裂（issue #6 Task 1）
-- 路由 server/src/routes/problem-solving-logs.ts 插入 related_draft_ids，
-- 但 000_init.sql / 000_init_missing_tables.sql 建表均无此列 → 插入必然失败，
-- 连带「我明白了」闭环、反思数据源、问题日志统计全部失效。
-- 幂等，可重复执行。运行方式：Supabase SQL Editor → 粘贴 → Run
-- ===========================================

ALTER TABLE public.problem_solving_logs
    ADD COLUMN IF NOT EXISTS related_draft_ids JSONB DEFAULT '[]'::jsonb;
