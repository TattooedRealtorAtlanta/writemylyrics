const { supabase, PLAN_LIMITS, getUser, getProfile } = require('./_lib/supabase');
const { sendWelcomeEmail, scheduleNudgeEmail, sendDay3Email, sendDay7Email, sendDay14Email } = require('./_lib/resend');

const NURTURE_BATCH = 50; // max users to email per cron run per tier

async function handleNurtureCron(res) {
  const now = new Date();
  const sent = { day3: 0, day7: 0, day14: 0 };

  // Cutoffs: send if signed up at least N days ago and flag not yet set.
  // Using <= threshold (not a narrow window) so missed cron runs self-heal on next run.
  // 60-day upper bound prevents emailing very old accounts if migration ran late.
  const upper = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
  const cut3  = new Date(now -  3 * 24 * 60 * 60 * 1000).toISOString();
  const cut7  = new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString();
  const cut14 = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  // ── Day 3: zero-song users ────────────────────────────────────────────────
  const { data: day3Users } = await supabase
    .from('profiles')
    .select('id, email, name')
    .eq('warn3_sent', false)
    .eq('usage_count', 0)
    .lte('created_at', cut3)
    .gte('created_at', upper)
    .limit(NURTURE_BATCH);

  for (const u of day3Users || []) {
    const { data: claimed } = await supabase
      .from('profiles')
      .update({ warn3_sent: true })
      .eq('id', u.id)
      .eq('warn3_sent', false)
      .select('id')
      .single();
    if (claimed) {
      await sendDay3Email(u.email, u.name).catch(e => console.error('[nurture day3]', u.id, e.message));
      sent.day3++;
    }
  }

  // ── Day 7: all users ──────────────────────────────────────────────────────
  const { data: day7Users } = await supabase
    .from('profiles')
    .select('id, email, name')
    .eq('warn7_sent', false)
    .lte('created_at', cut7)
    .gte('created_at', upper)
    .limit(NURTURE_BATCH);

  for (const u of day7Users || []) {
    const { data: claimed } = await supabase
      .from('profiles')
      .update({ warn7_sent: true })
      .eq('id', u.id)
      .eq('warn7_sent', false)
      .select('id')
      .single();
    if (claimed) {
      await sendDay7Email(u.email, u.name).catch(e => console.error('[nurture day7]', u.id, e.message));
      sent.day7++;
    }
  }

  // ── Day 14: free-plan users only (upgrade push) ───────────────────────────
  const { data: day14Users } = await supabase
    .from('profiles')
    .select('id, email, name')
    .eq('warn14_sent', false)
    .eq('plan', 'free')
    .lte('created_at', cut14)
    .gte('created_at', upper)
    .limit(NURTURE_BATCH);

  for (const u of day14Users || []) {
    const { data: claimed } = await supabase
      .from('profiles')
      .update({ warn14_sent: true })
      .eq('id', u.id)
      .eq('warn14_sent', false)
      .select('id')
      .single();
    if (claimed) {
      await sendDay14Email(u.email, u.name).catch(e => console.error('[nurture day14]', u.id, e.message));
      sent.day14++;
    }
  }

  console.log('[nurture cron] sent:', sent);
  return res.status(200).json({ ok: true, sent });
}

module.exports = async function handler(req, res) {
  // ── CRON: GET /api/user?action=nurture ──────────────────────────────────
  // Invoked daily by Vercel Cron. Requires CRON_SECRET env var set in Vercel dashboard.
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && urlObj.searchParams.get('action') === 'nurture') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return handleNurtureCron(res);
  }

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

    // ── Send welcome emails on first login ───────────────────────────────
    // Atomic claim: only proceeds for the row where welcome_sent is still false.
    // If two requests race, only one UPDATE returns a row — prevents duplicates.
    if (!profile.welcome_sent) {
      const { data: claimed, error: claimErr } = await supabase
        .from('profiles')
        .update({ welcome_sent: true })
        .eq('id', user.id)
        .eq('welcome_sent', false)
        .select('id')
        .single();

      if (claimErr) {
        // Most likely cause: migration not yet run — welcome_sent column missing
        console.error('[/api/user] welcome_sent claim failed:', claimErr.message, '| code:', claimErr.code);
      }

      if (claimed) {
        // This request won the race — send all three emails
        const signupTime = new Date();
        const displayName = profile.name || name || '';
        const toEmail = profile.email || user.email;

        try {
          // Email 1 — immediate
          await sendWelcomeEmail(toEmail, displayName);

          // Email 2 — 48h nudge (scheduled; store ID so we can cancel on first gen)
          const nudgeResult = await scheduleNudgeEmail(toEmail, displayName, signupTime);
          if (nudgeResult?.id) {
            await supabase
              .from('profiles')
              .update({ email_nudge_id: nudgeResult.id })
              .eq('id', user.id);
          }
          // Day 7 / Day 14 emails are handled by the daily nurture cron (/api/user?action=nurture)

        } catch (emailErr) {
          // Email failure must never break the login flow
          console.error('[/api/user] welcome email error:', emailErr.message);
        }
      }
    }

    // Reset monthly usage if 30+ days have passed
    const now = new Date();
    const resetAt = new Date(profile.usage_reset_at);
    const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);
    let usageCount = profile.usage_count;

    if (daysSinceReset >= 30 && profile.plan === 'free') {
      await supabase
        .from('profiles')
        .update({ usage_count: 0, usage_reset_at: now.toISOString() })
        .eq('id', user.id);
      usageCount = 0;
    }

    // Count paying Pro members (active Stripe subscription only) for upgrade modal
    let proCount = 0;
    try {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .in('plan', ['pro', 'unlimited'])
        .not('stripe_subscription_id', 'is', null);
      proCount = count || 0;
    } catch { /* non-critical */ }

    // Lifetime song count — used client-side to distinguish true new users from monthly resets
    let songsCount = 0;
    try {
      const { count } = await supabase
        .from('songs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);
      songsCount = count || 0;
    } catch { /* non-critical */ }

    return res.status(200).json({
      id: profile.id,
      email: profile.email,
      name: profile.name,
      plan: profile.plan,
      usage: usageCount,
      limit: PLAN_LIMITS[profile.plan] ?? 5,
      reset_at: profile.usage_reset_at || null,
      pro_count: proCount,
      songs_count: songsCount,
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

  // ── DELETE: permanently delete account and all associated data ──────────
  if (req.method === 'DELETE') {
    // supabase.auth.admin.deleteUser cascades through all foreign keys:
    // profiles, songs, song_versions, song_votes, song_cowriters, song_suggestions
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) {
      console.error('[/api/user DELETE] deleteUser error:', error.message);
      return res.status(500).json({ error: 'Failed to delete account: ' + error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
