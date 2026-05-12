const { supabase, PLAN_LIMITS, getUser, getProfile } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const name = user.user_metadata?.name || user.user_metadata?.full_name;

  let profile;
  try {
    profile = await getProfile(user.id, user.email, name);
  } catch (e) {
    console.error('[/api/user] getProfile threw:', e.message);
    return res.status(500).json({ error: e.message });
  }

  if (!profile) {
    console.error('[/api/user] getProfile returned null for user:', user.id);
    return res.status(500).json({ error: 'Profile not found' });
  }

  // Reset monthly usage if 30+ days have passed
  const now = new Date();
  const resetAt = new Date(profile.usage_reset_at);
  const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);
  let usageCount = profile.usage_count;

  if (daysSinceReset >= 30 && profile.plan !== 'unlimited') {
    await supabase
      .from('profiles')
      .update({ usage_count: 0, usage_reset_at: now.toISOString() })
      .eq('id', user.id);
    usageCount = 0;
  }

  return res.status(200).json({
    id: profile.id,
    email: profile.email,
    name: profile.name,
    plan: profile.plan,
    usage: usageCount,
    limit: PLAN_LIMITS[profile.plan] ?? 5
  });
};
