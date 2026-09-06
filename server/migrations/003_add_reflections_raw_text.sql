-- ===========================================
-- 反思解析失败兜底（issue #6 Task 4）
-- 4 维度正则解析失败时不丢内容：raw_text 保留 LLM 原始全文。
-- 幂等，可重复执行。运行方式：Supabase SQL Editor → 粘贴 → Run
-- ===========================================

ALTER TABLE public.reflections
    ADD COLUMN IF NOT EXISTS raw_text TEXT;
