-- supabase-settings.sql
-- Run this in the Supabase SQL Editor to add user settings columns to profiles

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS default_genre     text,
  ADD COLUMN IF NOT EXISTS default_moods     text,
  ADD COLUMN IF NOT EXISTS default_tempo     text,
  ADD COLUMN IF NOT EXISTS default_structure text,
  ADD COLUMN IF NOT EXISTS default_pov       text,
  ADD COLUMN IF NOT EXISTS default_language  text;

-- Allow users to update their own settings columns via the anon client
-- (API routes use service-role which already bypasses RLS)
-- The existing "profiles: user can update own name" policy covers all columns already
-- Nothing extra needed — the service-role key in /api/user.js handles updates server-side
