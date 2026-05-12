if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const Anthropic = require('@anthropic-ai/sdk');
const { getUser } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const body = await getJsonBody(req);
  const { lyrics, genre, moods, topic } = body;
  if (!lyrics) return res.status(400).json({ error: 'lyrics is required' });

  const contextParts = [
    genre  && `Genre: ${genre}`,
    moods  && `Mood: ${Array.isArray(moods) ? moods.join(', ') : moods}`,
    topic  && `Topic: ${topic}`,
  ].filter(Boolean);
  const context = contextParts.length ? contextParts.join(' | ') : '';

  const prompt = `You are a TikTok viral content strategist and songwriter. Generate exactly 3 TikTok hook options for the song below.

${context ? `Song context: ${context}\n` : ''}Lyrics:
${lyrics.slice(0, 1500)}

Rules for each hook:
- Maximum 3 sentences / ~15 seconds when spoken or sung
- Must open with a pattern interrupt that stops the scroll (a surprising statement, bold claim, visceral image, or unexpected twist)
- Punchy, conversational, zero filler words
- Each hook should use a completely different angle or emotional entry point
- Hooks are text meant to be spoken/sung as an opening — not hashtags or captions

Return ONLY a JSON array of exactly 3 strings, no other text, no markdown fences:
["hook one text here","hook two text here","hook three text here"]`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = msg.content[0]?.text?.trim() || '';

    // Parse the JSON array — strip any accidental fences
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
    let hooks;
    try {
      hooks = JSON.parse(cleaned);
    } catch {
      // Fallback: extract array with regex
      const m = cleaned.match(/\[[\s\S]*\]/);
      hooks = m ? JSON.parse(m[0]) : [];
    }

    if (!Array.isArray(hooks) || hooks.length === 0) {
      return res.status(500).json({ error: 'Could not parse hooks from AI response' });
    }

    return res.status(200).json({ hooks: hooks.slice(0, 3) });
  } catch (e) {
    console.error('[hooks]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
