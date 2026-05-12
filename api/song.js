if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { supabase } = require('./_lib/supabase');

// Public endpoint — no auth required
// GET /api/song?id=xxx
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.searchParams.get('id');
  if (!id) return res.status(400).json({ error: 'id is required' });

  const { data, error } = await supabase
    .from('gallery_songs')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Song not found or not published' });

  return res.status(200).json({ song: data });
};
