if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { supabase, getUser } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const body = await getJsonBody(req);
  const { song_id } = body;
  if (!song_id) return res.status(400).json({ error: 'song_id is required' });

  // Verify the song is published
  const { data: song } = await supabase
    .from('songs')
    .select('id')
    .eq('id', song_id)
    .eq('published', true)
    .single();
  if (!song) return res.status(404).json({ error: 'Song not found or not published' });

  // Check for existing vote
  const { data: existing } = await supabase
    .from('song_votes')
    .select('id')
    .eq('song_id', song_id)
    .eq('user_id', user.id)
    .maybeSingle();

  let voted;
  if (existing) {
    // Un-vote
    await supabase.from('song_votes').delete().eq('id', existing.id);
    voted = false;
  } else {
    // Vote
    await supabase.from('song_votes').insert({ song_id, user_id: user.id });
    voted = true;
  }

  // Return authoritative vote count
  const { count } = await supabase
    .from('song_votes')
    .select('*', { count: 'exact', head: true })
    .eq('song_id', song_id);

  return res.status(200).json({ voted, vote_count: count || 0 });
};
