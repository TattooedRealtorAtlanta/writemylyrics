-- ============================================================
-- WriteMyLyrics — Songs Table
-- Run in Supabase Dashboard → SQL Editor → New Query
-- ============================================================

create table if not exists public.songs (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  title       text,
  lyrics      text        not null,
  genre       text,
  moods       text,
  tempo       text,
  structure   text,
  rhyme       text,
  pov         text,
  topic       text,
  style_notes text,
  chords      text,
  suno_prompt text,
  sync_data   text,
  created_at  timestamptz not null default now()
);

alter table public.songs enable row level security;

create policy "songs: user can view own"
  on public.songs for select
  using (auth.uid() = user_id);

create policy "songs: user can insert own"
  on public.songs for insert
  with check (auth.uid() = user_id);

create policy "songs: user can update own"
  on public.songs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "songs: user can delete own"
  on public.songs for delete
  using (auth.uid() = user_id);
