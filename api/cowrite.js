if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { supabase, getUser } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── GET /api/cowrite?song_id=xxx  — cowriters for a song I own ──────────
  if (req.method === 'GET' && url.searchParams.get('song_id')) {
    const songId = url.searchParams.get('song_id');

    // Verify ownership
    const { data: song } = await supabase
      .from('songs').select('id').eq('id', songId).eq('user_id', user.id).single();
    if (!song) return res.status(403).json({ error: 'Not your song' });

    const { data, error } = await supabase
      .from('song_cowriters')
      .select('*')
      .eq('song_id', songId)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ cowriters: data });
  }

  // ── GET /api/cowrite?mine=true  — songs I'm invited to co-write ─────────
  if (req.method === 'GET' && url.searchParams.get('mine')) {
    const email = user.email;

    // Auto-link any unlinked invites that match this email
    await supabase
      .from('song_cowriters')
      .update({ invitee_id: user.id })
      .eq('invitee_email', email)
      .is('invitee_id', null);

    // Fetch accepted invites + the song details
    const { data: invites, error } = await supabase
      .from('song_cowriters')
      .select('id, song_id, owner_id, status, created_at')
      .eq('invitee_id', user.id)
      .eq('status', 'accepted');

    if (error) return res.status(500).json({ error: error.message });
    if (!invites?.length) return res.status(200).json({ songs: [] });

    const songIds = invites.map(i => i.song_id);
    const { data: songs } = await supabase
      .from('songs')
      .select('id, title, topic, genre, lyrics, created_at, audio_url')
      .in('id', songIds);

    // Attach invite id to each song
    const result = (songs || []).map(s => ({
      ...s,
      invite_id: invites.find(i => i.song_id === s.id)?.id
    }));

    return res.status(200).json({ songs: result });
  }

  // ── POST — invite a co-writer ────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = await getJsonBody(req);
    const { song_id, email } = body;
    if (!song_id || !email) return res.status(400).json({ error: 'song_id and email are required' });

    // Verify ownership
    const { data: song } = await supabase
      .from('songs').select('id').eq('id', song_id).eq('user_id', user.id).single();
    if (!song) return res.status(403).json({ error: 'Not your song' });

    // Can't invite yourself
    if (email.toLowerCase() === user.email?.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot invite yourself' });
    }

    // Look up invitee user_id if they already have an account
    const { data: inviteeProfile } = await supabase
      .from('profiles').select('id').eq('email', email.toLowerCase()).maybeSingle();

    const { data, error } = await supabase
      .from('song_cowriters')
      .insert({
        song_id,
        owner_id: user.id,
        invitee_email: email.toLowerCase(),
        invitee_id: inviteeProfile?.id || null,
        status: 'accepted'   // auto-accept for simplicity; invitee just gets access
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Already invited' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ cowriter: data });
  }

  // ── DELETE /api/cowrite?id=xxx — remove a co-writer ─────────────────────
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id is required' });

    // Allow owner or the invitee themselves to remove
    const { error } = await supabase
      .from('song_cowriters')
      .delete()
      .eq('id', id)
      .or(`owner_id.eq.${user.id},invitee_id.eq.${user.id}`);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
