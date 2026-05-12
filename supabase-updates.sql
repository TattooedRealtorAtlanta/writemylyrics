-- ============================================================
-- WriteMyLyrics — Schema Updates
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. Add notes column to songs table
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS notes text;

-- 2. Add status column to songs table (draft | in-progress | sent-to-suno | published)
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

-- 3. Song versions table
CREATE TABLE IF NOT EXISTS public.song_versions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id    uuid        NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
  lyrics     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.song_versions ENABLE ROW LEVEL SECURITY;

-- Versions RLS: users can only access versions for their own songs
CREATE POLICY "versions: user can view own"
  ON public.song_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.songs
      WHERE songs.id = song_id AND songs.user_id = auth.uid()
    )
  );

CREATE POLICY "versions: user can insert own"
  ON public.song_versions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.songs
      WHERE songs.id = song_id AND songs.user_id = auth.uid()
    )
  );

CREATE POLICY "versions: user can delete own"
  ON public.song_versions FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.songs
      WHERE songs.id = song_id AND songs.user_id = auth.uid()
    )
  );
