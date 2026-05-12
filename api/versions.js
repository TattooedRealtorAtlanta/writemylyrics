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

  // Helper: verify caller owns the song
  async function ownsSong(songId) {
    const { data } = await supabase
      .from('songs')
      .select('id')
      .eq('id', songId)
      .eq('user_id', user.id)
      .single();
    return !!data;
  }

  // GET /api/versions?songId=xxx — list versions
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const songId = url.searchParams.get('songId');
    if (!songId) return res.status(400).json({ error: 'songId is required' });
    if (!(await ownsSong(songId))) return res.status(404).json({ error: 'Song not found' });

    const { data, error } = await supabase
      .from('song_versions')
      .select('id, song_id, lyrics, created_at')
      .eq('song_id', songId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[versions GET]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ versions: data });
  }

  // POST /api/versions — save a version { songId, lyrics }
  if (req.method === 'POST') {
    const body = await getJsonBody(req);
    const { songId, lyrics } = body;
    if (!songId || !lyrics) return res.status(400).json({ error: 'songId and lyrics are required' });
    if (!(await ownsSong(songId))) return res.status(404).json({ error: 'Song not found' });

    const { data, error } = await supabase
      .from('song_versions')
      .insert({ song_id: songId, lyrics })
      .select()
      .single();

    if (error) {
      console.error('[versions POST]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ version: data });
  }

  // DELETE /api/versions?id=xxx
  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id is required' });

    // RLS policy handles ownership via EXISTS check on songs
    const { error } = await supabase
      .from('song_versions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[versions DELETE]', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
