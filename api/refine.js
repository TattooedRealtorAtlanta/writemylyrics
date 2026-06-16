if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const Anthropic = require('@anthropic-ai/sdk');
const { supabase, getUser, getProfile, PLAN_LIMITS } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const profile = await getProfile(user.id, user.email, user.user_metadata?.name);
  if (profile.plan === 'free') {
    return res.status(403).json({ error: 'Tweak & Refine requires a Pro plan' });
  }

  const limit = PLAN_LIMITS[profile.plan] ?? 5;
  if (profile.usage_count >= limit) {
    return res.status(429).json({ error: 'Monthly limit reached' });
  }

  const body = await getJsonBody(req);
  const { lyrics, instructions, genre, moods, tempo, topic, songId, action, refineChords } = body;

  if (!lyrics) {
    return res.status(400).json({ error: 'lyrics is required' });
  }

  const contextLines = [
    genre && `Genre: ${genre}`,
    moods && `Mood: ${Array.isArray(moods) ? moods.join(', ') : moods}`,
    tempo && `Tempo: ${tempo}`,
    topic && `Topic: ${topic}`
  ].filter(Boolean);

  const ctx = contextLines.length ? '\n\nSong context:\n' + contextLines.join('\n') : '';

  let prompt;
  if (action === 'upload_rewrite') {
    prompt = `You are an expert songwriter and lyricist. The user has written their own song lyrics and wants a professional rewrite.${ctx}

Original lyrics:
${lyrics}

Rewrite these lyrics with improved rhyme scheme, better flow, and stronger structure — while preserving the original meaning, story, and emotional core. Keep every section label (VERSE 1, CHORUS, BRIDGE, etc.) in the same format. Return ONLY the rewritten lyrics — no explanations, no commentary, no preamble.`;
  } else if (action === 'upload_complete') {
    prompt = `You are an expert songwriter and lyricist. The user has partial song lyrics with [INCOMPLETE] markers where they got stuck.${ctx}

Partial lyrics:
${lyrics}

Fill in every [INCOMPLETE] section with new lyrics that match the style, tone, rhyme scheme, and voice of the existing sections. Keep all existing lyric lines exactly as written — only replace [INCOMPLETE] markers. Keep every section label (VERSE 1, CHORUS, BRIDGE, etc.) in the same format. Return ONLY the complete lyrics — no explanations, no commentary, no preamble.`;
  } else {
    if (!instructions) {
      return res.status(400).json({ error: 'lyrics and instructions are required' });
    }
    prompt = `You are an expert songwriter and lyricist. The user has existing song lyrics and wants specific changes made.${ctx}

Original lyrics:
${lyrics}

User's refinement instructions:
${instructions}

Apply the requested changes. Preserve the overall structure and what's working well. Return ONLY the updated lyrics — no explanations, no commentary, no preamble. Keep the same section labels (VERSE 1, CHORUS, BRIDGE, etc.) in the same format.`;
  }

  const moodStr = Array.isArray(moods) ? moods.join(', ') : (moods || '');
  const chordsPrompt = `Chord progression for:\nGenre: ${genre || 'Unspecified'}\nMood: ${moodStr || 'Unspecified'}\nTempo: ${tempo || 'Mid tempo'}\n\nRespond EXACTLY:\nKEY: [key]\nSTRUMMING: [pattern]\n\n[section]: [chords with em dashes]\n(one line per section)`;

  const calls = [
    anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    refineChords
      ? anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 400, messages: [{ role: 'user', content: chordsPrompt }] })
      : Promise.resolve(null)
  ];

  const [lyricsMsg, chordsMsg] = await Promise.all(calls);
  const refined = lyricsMsg.content[0]?.text?.trim();
  const newChords = chordsMsg ? chordsMsg.content[0]?.text?.trim() : null;
  if (!refined) return res.status(500).json({ error: 'AI returned empty response' });

  // Save the original lyrics as a version before returning the refined version
  if (songId) {
    const { data: songCheck } = await supabase
      .from('songs')
      .select('id')
      .eq('id', songId)
      .eq('user_id', user.id)
      .single();
    if (songCheck) {
      await supabase
        .from('song_versions')
        .insert({ song_id: songId, lyrics }); // lyrics = original, before refinement
    }
  }

  // Increment usage
  const newCount = profile.usage_count + 1;
  await supabase.from('profiles').update({ usage_count: newCount }).eq('id', user.id);

  return res.status(200).json({
    lyrics: refined,
    chords: newChords || null,
    usage: newCount,
    limit,
    plan: profile.plan
  });
};
