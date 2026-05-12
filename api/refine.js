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
    return res.status(403).json({ error: 'Tweak & Refine requires Pro or Unlimited plan' });
  }

  const limit = PLAN_LIMITS[profile.plan] ?? 5;
  if (profile.usage_count >= limit) {
    return res.status(429).json({ error: 'Monthly limit reached' });
  }

  const body = await getJsonBody(req);
  const { lyrics, instructions, genre, moods, tempo, topic } = body;

  if (!lyrics || !instructions) {
    return res.status(400).json({ error: 'lyrics and instructions are required' });
  }

  const contextLines = [
    genre && `Genre: ${genre}`,
    moods && `Mood: ${Array.isArray(moods) ? moods.join(', ') : moods}`,
    tempo && `Tempo: ${tempo}`,
    topic && `Topic: ${topic}`
  ].filter(Boolean);

  const prompt = `You are an expert songwriter and lyricist. The user has existing song lyrics and wants specific changes made.${contextLines.length ? '\n\nSong context:\n' + contextLines.join('\n') : ''}

Original lyrics:
${lyrics}

User's refinement instructions:
${instructions}

Apply the requested changes. Preserve the overall structure and what's working well. Return ONLY the updated lyrics — no explanations, no commentary, no preamble. Keep the same section labels (VERSE 1, CHORUS, BRIDGE, etc.) in the same format.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const refined = message.content[0]?.text?.trim();
  if (!refined) return res.status(500).json({ error: 'AI returned empty response' });

  // Increment usage
  const newCount = profile.usage_count + 1;
  await supabase.from('profiles').update({ usage_count: newCount }).eq('id', user.id);

  return res.status(200).json({
    lyrics: refined,
    usage: newCount,
    limit,
    plan: profile.plan
  });
};
