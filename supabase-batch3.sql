-- ============================================================
-- WriteMyLyrics — Schema Batch 3
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── CO-WRITER INVITES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.song_cowriters (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id       uuid        NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
  owner_id      uuid        NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  invitee_email text        NOT NULL,
  invitee_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (song_id, invitee_email)
);

ALTER TABLE public.song_cowriters ENABLE ROW LEVEL SECURITY;

-- Owner can do everything on their invites
CREATE POLICY "cowriters_owner"
  ON public.song_cowriters FOR ALL
  USING (auth.uid() = owner_id);

-- Invitee can see and update their own invite (to accept/reject)
CREATE POLICY "cowriters_invitee_select"
  ON public.song_cowriters FOR SELECT
  USING (auth.uid() = invitee_id);

CREATE POLICY "cowriters_invitee_update"
  ON public.song_cowriters FOR UPDATE
  USING (auth.uid() = invitee_id);

-- ── LYRIC SUGGESTIONS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.song_suggestions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id        uuid        NOT NULL REFERENCES public.songs(id) ON DELETE CASCADE,
  author_id      uuid        NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  author_name    text,
  suggested_text text        NOT NULL,
  comment        text,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','accepted','rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.song_suggestions ENABLE ROW LEVEL SECURITY;

-- Song owner can do everything on suggestions for their songs
CREATE POLICY "suggestions_owner"
  ON public.song_suggestions FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.songs WHERE id = song_id AND user_id = auth.uid()
  ));

-- Suggestion author can view and delete their own suggestions
CREATE POLICY "suggestions_author"
  ON public.song_suggestions FOR ALL
  USING (auth.uid() = author_id);

-- Accepted co-writers can view suggestions on the shared song
CREATE POLICY "suggestions_cowriter_select"
  ON public.song_suggestions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.song_cowriters
    WHERE song_id = song_suggestions.song_id
      AND invitee_id = auth.uid()
      AND status = 'accepted'
  ));
