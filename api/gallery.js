if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { supabase, getUser } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST /api/gallery — vote / un-vote ───────────────────────────────────
  if (req.method === 'POST') {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const body = await getJsonBody(req);
    const { song_id } = body;
    if (!song_id) return res.status(400).json({ error: 'song_id is required' });

    const { data: song } = await supabase
      .from('songs').select('id').eq('id', song_id).eq('published', true).single();
    if (!song) return res.status(404).json({ error: 'Song not found or not published' });

    const { data: existing } = await supabase
      .from('song_votes').select('id').eq('song_id', song_id).eq('user_id', user.id).maybeSingle();

    let voted;
    if (existing) {
      await supabase.from('song_votes').delete().eq('id', existing.id);
      voted = false;
    } else {
      await supabase.from('song_votes').insert({ song_id, user_id: user.id });
      voted = true;
    }

    const { count } = await supabase
      .from('song_votes').select('*', { count: 'exact', head: true }).eq('song_id', song_id);

    return res.status(200).json({ voted, vote_count: count || 0 });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Optional auth — provides user_votes list
  const user = await getUser(req).catch(() => null);

  const url    = new URL(req.url, `http://${req.headers.host}`);
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const genre  = url.searchParams.get('genre') || '';
  const search = url.searchParams.get('search') || '';
  const limit  = 24;
  const from   = (page - 1) * limit;
  const to     = from + limit - 1;

  // ── Main gallery query ──
  let q = supabase
    .from('gallery_songs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (genre)  q = q.eq('genre', genre);
  if (search) q = q.ilike('title', `%${search}%`);

  const { data: songs, count, error } = await q;
  if (error) {
    console.error('[gallery GET]', error.message);
    return res.status(500).json({ error: error.message });
  }

  // ── Weekly Top 10 ──
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentVotes } = await supabase
    .from('song_votes')
    .select('song_id')
    .gte('created_at', sevenDaysAgo);

  const weeklyMap = {};
  (recentVotes || []).forEach(v => {
    weeklyMap[v.song_id] = (weeklyMap[v.song_id] || 0) + 1;
  });

  const weeklyTopIds = Object.entries(weeklyMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  let weekly_top10 = [];
  if (weeklyTopIds.length) {
    const { data: weeklyRows } = await supabase
      .from('gallery_songs')
      .select('*')
      .in('id', weeklyTopIds);
    weekly_top10 = (weeklyRows || [])
      .map(s => ({ ...s, weekly_votes: weeklyMap[s.id] || 0 }))
      .sort((a, b) => b.weekly_votes - a.weekly_votes);
  }

  // ── Hall of Fame (all-time top 10) ──
  const { data: hof } = await supabase
    .from('gallery_songs')
    .select('*')
    .order('vote_count', { ascending: false })
    .limit(10);

  // ── Current user's votes ──
  let user_votes = [];
  if (user) {
    const { data: votes } = await supabase
      .from('song_votes')
      .select('song_id')
      .eq('user_id', user.id);
    user_votes = (votes || []).map(v => v.song_id);
  }

  return res.status(200).json({
    songs:        songs || [],
    total:        count || 0,
    page,
    weekly_top10,
    hall_of_fame: hof || [],
    user_votes
  });
};
