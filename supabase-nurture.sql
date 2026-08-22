-- ============================================================
-- WriteMyLyrics — Nurture Email Sequence Migration
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Add nurture tracking flags to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS warn3_sent  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warn7_sent  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warn14_sent boolean NOT NULL DEFAULT false;

-- Mark all existing users as already-sent so the daily cron
-- doesn't backfill emails to people who signed up before this feature.
-- New users (inserted after this migration) default to false and
-- will receive the nurture sequence normally.
UPDATE public.profiles
SET warn3_sent = true, warn7_sent = true, warn14_sent = true;
