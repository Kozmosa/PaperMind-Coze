-- ===========================================
-- 资料表持久化提取文本（对齐「上传预处理」pipeline：
-- 上传/分类时提取一次，打开时直接读取，不再重跑 pdf-parse/视觉 OCR）
-- 幂等，可重复执行。运行方式：Supabase SQL Editor → 粘贴 → Run
-- ===========================================

ALTER TABLE public.materials
    ADD COLUMN IF NOT EXISTS extracted_text TEXT;
