-- ============================================================
-- WriteMyLyrics — Schema Batch 2
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Add artist_style column to songs table
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS artist_style text;

-- ============================================================
-- GALLERY — Batch 2 additions
-- ============================================================

-- published flag on songs (false by default — songs are private)
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false;

-- ── SONG VOTES ──
CREATE TABLE IF NOT EXISTS public.song_votes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id    uuid        NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (song_id, user_id)
);

ALTER TABLE public.song_votes ENABLE ROW LEVEL SECURITY;

-- Anyone can read votes (needed for vote counts)
CREATE POLICY "Anyone can view votes"
  ON public.song_votes FOR SELECT
  USING (true);

-- Users can only insert their own vote
CREATE POLICY "Users insert own votes"
  ON public.song_votes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only delete their own vote
CREATE POLICY "Users delete own votes"
  ON public.song_votes FOR DELETE
  USING (auth.uid() = user_id);

-- ── GALLERY VIEW ──
-- Published songs with all-time vote counts and author display names
CREATE OR REPLACE VIEW public.gallery_songs AS
SELECT
  s.id,
  s.title,
  s.genre,
  s.moods,
  s.tempo,
  s.artist_style,
  s.lyrics,
  s.chords,
  s.created_at,
  s.user_id,
  COALESCE(p.name, 'Anonymous') AS author_name,
  COUNT(sv.id)::int             AS vote_count
FROM   public.songs       s
LEFT   JOIN public.profiles    p  ON p.id      = s.user_id
LEFT   JOIN public.song_votes  sv ON sv.song_id = s.id
WHERE  s.published = true
GROUP  BY s.id, p.name;

-- Grant read access on the view to all roles
GRANT SELECT ON public.gallery_songs TO anon, authenticated;

-- ============================================================
-- AUDIO URL — Batch 2 additions
-- ============================================================

-- Persistent Suno audio URL per song (nullable)
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS audio_url text;

-- Rebuild gallery view to expose audio_url
CREATE OR REPLACE VIEW public.gallery_songs AS
SELECT
  s.id,
  s.title,
  s.genre,
  s.moods,
  s.tempo,
  s.artist_style,
  s.lyrics,
  s.chords,
  s.audio_url,
  s.created_at,
  s.user_id,
  COALESCE(p.name, 'Anonymous') AS author_name,
  COUNT(sv.id)::int             AS vote_count
FROM   public.songs       s
LEFT   JOIN public.profiles    p  ON p.id      = s.user_id
LEFT   JOIN public.song_votes  sv ON sv.song_id = s.id
WHERE  s.published = true
GROUP  BY s.id, p.name;

GRANT SELECT ON public.gallery_songs TO anon, authenticated;
