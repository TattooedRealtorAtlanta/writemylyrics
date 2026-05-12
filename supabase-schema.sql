-- ============================================================
-- WriteMyLyrics — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Profiles table (one row per auth user)
create table if not exists public.profiles (
  id                    uuid        primary key references auth.users(id) on delete cascade,
  email                 text,
  name                  text,
  plan                  text        not null default 'free'
                                    check (plan in ('free', 'pro', 'unlimited')),
  usage_count           integer     not null default 0,
  usage_reset_at        timestamptz not null default now(),
  stripe_customer_id    text        unique,
  stripe_subscription_id text       unique,
  created_at            timestamptz not null default now()
);

-- Row-level security
alter table public.profiles enable row level security;

-- Users can read and update their own row
-- API routes use the service-role key which bypasses RLS
create policy "profiles: user can view own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: user can update own name"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Drop old trigger if it exists, then recreate
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
