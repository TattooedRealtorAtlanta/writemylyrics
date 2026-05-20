if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { supabase, getUser, getProfile } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const profile = await getProfile(user.id, user.email, user.user_metadata?.name);
  if (profile.plan === 'free') {
    return res.status(403).json({ error: 'Co-writer suggestions require a Pro plan' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Helper: verify user is song owner or accepted co-writer
  async function canAccess(songId) {
    const { data: owned } = await supabase
      .from('songs').select('id').eq('id', songId).eq('user_id', user.id).maybeSingle();
    if (owned) return { access: true, isOwner: true };

    const { data: invite } = await supabase
      .from('song_cowriters')
      .select('id')
      .eq('song_id', songId)
      .eq('invitee_id', user.id)
      .eq('status', 'accepted')
      .maybeSingle();
    return { access: !!invite, isOwner: false };
  }

  // ── GET /api/suggestions?song_id=xxx ────────────────────────────────────
  if (req.method === 'GET') {
    const songId = url.searchParams.get('song_id');
    if (!songId) return res.status(400).json({ error: 'song_id is required' });

    const { access } = await canAccess(songId);
    if (!access) return res.status(403).json({ error: 'Access denied' });

    const { data, error } = await supabase
      .from('song_suggestions')
      .select('*')
      .eq('song_id', songId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ suggestions: data });
  }

  // ── POST — submit a suggestion ───────────────────────────────────────────
  if (req.method === 'POST') {
    const body = await getJsonBody(req);
    const { song_id, suggested_text, comment } = body;
    if (!song_id || !suggested_text) {
      return res.status(400).json({ error: 'song_id and suggested_text are required' });
    }

    // Must be an accepted co-writer (owners don't suggest to their own songs)
    const { data: invite } = await supabase
      .from('song_cowriters')
      .select('id')
      .eq('song_id', song_id)
      .eq('invitee_id', user.id)
      .eq('status', 'accepted')
      .maybeSingle();
    if (!invite) return res.status(403).json({ error: 'You are not a co-writer on this song' });

    const { data, error } = await supabase
      .from('song_suggestions')
      .insert({
        song_id,
        author_id: user.id,
        author_name: user.user_metadata?.name || user.email,
        suggested_text,
        comment: comment || null,
        status: 'pending'
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ suggestion: data });
  }

  // ── PATCH — owner accepts or rejects a suggestion ────────────────────────
  if (req.method === 'PATCH') {
    const body = await getJsonBody(req);
    const { id, status } = body;
    if (!id || !['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'id and status (accepted|rejected) are required' });
    }

    // Fetch suggestion and verify ownership
    const { data: suggestion } = await supabase
      .from('song_suggestions').select('*').eq('id', id).single();
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    const { data: song } = await supabase
      .from('songs').select('id').eq('id', suggestion.song_id).eq('user_id', user.id).maybeSingle();
    if (!song) return res.status(403).json({ error: 'Only the song owner can accept or reject suggestions' });

    // If accepting, apply the suggested lyrics to the song
    if (status === 'accepted') {
      await supabase
        .from('songs')
        .update({ lyrics: suggestion.suggested_text })
        .eq('id', suggestion.song_id);
    }

    const { data, error } = await supabase
      .from('song_suggestions')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ suggestion: data, lyricsUpdated: status === 'accepted' });
  }

  // ── DELETE /api/suggestions?id=xxx — author removes own suggestion ───────
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { error } = await supabase
      .from('song_suggestions')
      .delete()
      .eq('id', id)
      .eq('author_id', user.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
