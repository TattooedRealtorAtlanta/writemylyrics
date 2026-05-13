const { supabase, PLAN_LIMITS, getUser, getProfile } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // ── GET: return profile ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const name = user.user_metadata?.name || user.user_metadata?.full_name;

    let profile;
    try {
      profile = await getProfile(user.id, user.email, name);
    } catch (e) {
      console.error('[/api/user GET] getProfile threw:', e.message);
      return res.status(500).json({ error: e.message });
    }

    if (!profile) {
      console.error('[/api/user GET] getProfile returned null for user:', user.id);
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
      limit: PLAN_LIMITS[profile.plan] ?? 5,
      // Settings defaults
      default_genre:     profile.default_genre     || null,
      default_moods:     profile.default_moods     || null,
      default_tempo:     profile.default_tempo     || null,
      default_structure: profile.default_structure || null,
      default_pov:       profile.default_pov       || null,
      default_language:  profile.default_language  || null,
    });
  }

  // ── PATCH: save settings ─────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const {
      display_name,
      default_genre,
      default_moods,
      default_tempo,
      default_structure,
      default_pov,
      default_language,
    } = req.body || {};

    const updates = {};
    if (display_name   !== undefined) updates.name             = String(display_name).trim().slice(0, 80) || null;
    if (default_genre  !== undefined) updates.default_genre    = default_genre  || null;
    if (default_moods  !== undefined) updates.default_moods    = default_moods  || null;
    if (default_tempo  !== undefined) updates.default_tempo    = default_tempo  || null;
    if (default_structure !== undefined) updates.default_structure = default_structure || null;
    if (default_pov    !== undefined) updates.default_pov      = default_pov    || null;
    if (default_language !== undefined) updates.default_language = default_language || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();

    if (error) {
      console.error('[/api/user PATCH] update error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      id: data.id,
      email: data.email,
      name: data.name,
      plan: data.plan,
      default_genre:     data.default_genre     || null,
      default_moods:     data.default_moods     || null,
      default_tempo:     data.default_tempo     || null,
      default_structure: data.default_structure || null,
      default_pov:       data.default_pov       || null,
      default_language:  data.default_language  || null,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
