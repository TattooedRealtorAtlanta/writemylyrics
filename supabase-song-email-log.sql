-- Song-copy email tracking.
-- For a free user the song email is the only copy of what they wrote, so a
-- silent send failure is invisible: api/generate.js only console.warn's it and
-- Vercel logs age out. These columns make the outcome durable.
-- Applied to production 2026-10-31 (migration: song_email_tracking).

alter table public.profiles
  add column if not exists song_email_last_at    timestamptz,
  add column if not exists song_email_last_id    text,
  add column if not exists song_email_fail_count integer not null default 0;

-- Find users whose song copy never made it.
create index if not exists profiles_song_email_fail_idx
  on public.profiles (song_email_fail_count)
  where song_email_fail_count > 0;
