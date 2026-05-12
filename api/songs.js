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

  // GET /api/songs — list songs (pro/unlimited only)
  if (req.method === 'GET') {
    const profile = await getProfile(user.id, user.email, user.user_metadata?.name);
    if (profile.plan === 'free') {
      return res.status(403).json({ error: 'Song history requires Pro or Unlimited plan' });
    }

    const { data, error } = await supabase
      .from('songs')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[songs GET]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ songs: data });
  }

  // POST /api/songs — save song (pro/unlimited only)
  if (req.method === 'POST') {
    const profile = await getProfile(user.id, user.email, user.user_metadata?.name);
    if (profile.plan === 'free') {
      return res.status(403).json({ error: 'Song history requires Pro or Unlimited plan' });
    }

    const body = await getJsonBody(req);
    const { title, lyrics, genre, moods, tempo, structure, rhyme, pov, topic, style_notes, chords, suno_prompt, artist_style } = body;

    if (!lyrics) return res.status(400).json({ error: 'lyrics is required' });

    const { data, error } = await supabase
      .from('songs')
      .insert({
        user_id: user.id,
        title: title || null,
        lyrics,
        genre: genre || null,
        moods: Array.isArray(moods) ? moods.join(',') : (moods || null),
        tempo: tempo || null,
        structure: structure || null,
        rhyme: rhyme || null,
        pov: pov || null,
        topic: topic || null,
        style_notes: style_notes || null,
        chords: chords || null,
        suno_prompt: suno_prompt || null,
        artist_style: artist_style || null
      })
      .select()
      .single();

    if (error) {
      console.error('[songs POST]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ song: data });
  }

  // PATCH /api/songs — update any combination of: sync_data, notes, status, lyrics
  if (req.method === 'PATCH') {
    const body = await getJsonBody(req);
    const { id, sync_data, notes, status, lyrics, published, audio_url } = body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const updates = {};
    if (sync_data  !== undefined) updates.sync_data  = sync_data;
    if (notes      !== undefined) updates.notes      = notes;
    if (status     !== undefined) updates.status     = status;
    if (lyrics     !== undefined) updates.lyrics     = lyrics;
    if (published  !== undefined) updates.published  = published;
    if (audio_url  !== undefined) updates.audio_url  = audio_url;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('songs')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) {
      console.error('[songs PATCH]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ song: data });
  }

  // DELETE /api/songs?id=xxx
  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { error } = await supabase
      .from('songs')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      console.error('[songs DELETE]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
