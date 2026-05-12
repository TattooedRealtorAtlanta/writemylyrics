-- ============================================================
-- WriteMyLyrics — Schema Batch 2
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Add artist_style column to songs table
-- Stores the "write in the style of" artist name per song
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS artist_style text;
