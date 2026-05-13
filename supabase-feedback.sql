-- supabase-feedback.sql
-- Run this in the Supabase SQL Editor after supabase-admin.sql

-- Feedback table
CREATE TABLE IF NOT EXISTS public.feedback (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rating     smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment    text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

-- Authenticated users can insert their own feedback
CREATE POLICY "Users can insert own feedback" ON public.feedback
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Admin RPC: returns last 10 feedback items with user email
CREATE OR REPLACE FUNCTION admin_get_feedback()
RETURNS TABLE(
  id         uuid,
  user_id    uuid,
  email      text,
  rating     smallint,
  comment    text,
  created_at timestamptz
)
SECURITY DEFINER
LANGUAGE sql AS $$
  SELECT
    f.id,
    f.user_id,
    p.email,
    f.rating,
    f.comment,
    f.created_at
  FROM public.feedback f
  LEFT JOIN public.profiles p ON p.id = f.user_id
  ORDER BY f.created_at DESC
  LIMIT 10;
$$;
