const { createClient } = require('@supabase/supabase-js');

// Service-role client — full DB access, never expose to browser
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
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
  if (error || !user) return null;
  return user;
}

/**
 * Fetch (or auto-create) the user's profile row.
 */
async function getProfile(userId, email, name) {
  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (existing) return existing;

  // Create on first access if the DB trigger missed it
  const { data: created } = await supabase
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

  return created;
}

module.exports = { supabase, PLAN_LIMITS, getUser, getProfile };
