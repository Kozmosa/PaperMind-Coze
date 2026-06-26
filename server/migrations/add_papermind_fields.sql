-- Migration: Add PaperMind MVP1 fields to study_notes and materials tables
-- Run this in Supabase SQL Editor

-- ==========================================
-- study_notes table: add new columns
-- ==========================================
ALTER TABLE study_notes
ADD COLUMN IF NOT EXISTS logical_path TEXT,
ADD COLUMN IF NOT EXISTS papercore TEXT,
ADD COLUMN IF NOT EXISTS ai_processed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS viewed_after_process BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS blocks JSONB DEFAULT '[]'::jsonb;

-- ==========================================
-- materials table: add new columns
-- ==========================================
ALTER TABLE materials
ADD COLUMN IF NOT EXISTS logical_path TEXT,
ADD COLUMN IF NOT EXISTS papercore TEXT,
ADD COLUMN IF NOT EXISTS ai_processed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS viewed_after_process BOOLEAN DEFAULT FALSE;
