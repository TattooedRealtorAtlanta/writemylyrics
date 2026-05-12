-- ============================================================
-- WriteMyLyrics — Admin RPC Functions
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Returns all aggregate stats for the admin dashboard
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'total_users',      (SELECT count(*)::int FROM profiles),
    'plan_free',        (SELECT count(*)::int FROM profiles WHERE plan = 'free'),
    'plan_pro',         (SELECT count(*)::int FROM profiles WHERE plan = 'pro'),
    'plan_unlimited',   (SELECT count(*)::int FROM profiles WHERE plan = 'unlimited'),
    'signups_today',    (SELECT count(*)::int FROM profiles WHERE created_at >= current_date),
    'signups_week',     (SELECT count(*)::int FROM profiles WHERE created_at >= date_trunc('week', now())),
    'total_songs',      (SELECT count(*)::int FROM songs),
    'songs_today',      (SELECT count(*)::int FROM songs WHERE created_at >= current_date),
    'songs_week',       (SELECT count(*)::int FROM songs WHERE created_at >= date_trunc('week', now())),
    'top_genres',       (
      SELECT COALESCE(json_agg(g), '[]'::json)
      FROM (
        SELECT genre, count(*)::int AS cnt
        FROM songs
        WHERE genre IS NOT NULL AND genre <> ''
        GROUP BY genre
        ORDER BY cnt DESC
        LIMIT 5
      ) g
    ),
    'monthly_revenue_pro',       (SELECT count(*)::int FROM profiles WHERE plan = 'pro') * 9,
    'monthly_revenue_unlimited', (SELECT count(*)::int FROM profiles WHERE plan = 'unlimited') * 19,
    'monthly_revenue_total',     ((SELECT count(*)::int FROM profiles WHERE plan = 'pro') * 9) +
                                 ((SELECT count(*)::int FROM profiles WHERE plan = 'unlimited') * 19)
  ) INTO result;
  RETURN result;
END;
$$;

-- Returns the 10 most recent signups
CREATE OR REPLACE FUNCTION admin_get_recent_signups()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT COALESCE(json_agg(u), '[]'::json) INTO result
  FROM (
    SELECT email, name, plan, usage_count, created_at
    FROM profiles
    ORDER BY created_at DESC
    LIMIT 10
  ) u;
  RETURN result;
END;
$$;
