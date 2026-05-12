const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('[supabase.js] MISSING ENV VARS — SUPABASE_URL:', !!SUPABASE_URL, '| SUPABASE_SECRET_KEY:', !!SUPABASE_SECRET_KEY);
}

// Service-role client — full DB access, never expose to browser
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const PLAN_LIMITS = { free: 5, pro: 100, unlimited: Infinity };

/**
 * Verify a Supabase JWT and return the authenticated user.
 * Returns null if token is missing or invalid.
 */
async function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) {
    console.error('[getUser] supabase.auth.getUser error:', error.message);
    return null;
  }
  if (!user) return null;
  return user;
}

/**
 * Fetch (or auto-create) the user's profile row.
 */
async function getProfile(userId, email, name) {
  const { data: existing, error: fetchError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = "no rows found" — expected when profile doesn't exist yet
    console.error('[getProfile] fetch error:', fetchError.message, fetchError.code);
    throw new Error('DB fetch failed: ' + fetchError.message);
  }

  if (existing) return existing;

  // Create on first access if the DB trigger missed it
  const { data: created, error: insertError } = await supabase
    .from('profiles')
    .insert({
      id: userId,
      email,
      name: name || (email ? email.split('@')[0] : 'User'),
      plan: 'free',
      usage_count: 0,
      usage_reset_at: new Date().toISOString()
    })
    .select()
    .single();

  if (insertError) {
    console.error('[getProfile] insert error:', insertError.message, insertError.code);
    throw new Error('DB insert failed: ' + insertError.message);
  }

  return created;
}

module.exports = { supabase, PLAN_LIMITS, getUser, getProfile };
