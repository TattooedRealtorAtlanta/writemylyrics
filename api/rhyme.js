if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const Anthropic = require('@anthropic-ai/sdk');
const { getUser } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await getJsonBody(req);

  // ── POST /api/rhyme?action=hooks — TikTok hook generator ─────────────────
  if (url.searchParams.get('action') === 'hooks') {
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = msg.content[0]?.text?.trim() || '';
      const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      let hooks;
      try { hooks = JSON.parse(cleaned); }
      catch { const m = cleaned.match(/\[[\s\S]*\]/); hooks = m ? JSON.parse(m[0]) : []; }
      if (!Array.isArray(hooks) || hooks.length === 0) {
        return res.status(500).json({ error: 'Could not parse hooks from AI response' });
      }
      return res.status(200).json({ hooks: hooks.slice(0, 3) });
    } catch (e) {
      console.error('[hooks]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST /api/rhyme — rhyme suggestions ──────────────────────────────────
  const raw = (body.word || '').trim();
  if (!raw) return res.status(400).json({ error: 'word is required' });

  // Take only the first word, strip non-alphabetic characters
  const word = raw.split(/\s+/)[0].replace(/[^a-zA-Z'-]/g, '');
  if (!word) return res.status(400).json({ error: 'Invalid word' });

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    messages: [{
      role: 'user',
      content: `Provide rhymes for the word "${word}". Return ONLY a valid JSON object — no markdown, no explanation, no backticks:
{"perfect":["w1","w2","w3","w4","w5"],"near":["w1","w2","w3","w4","w5"],"slant":["w1","w2","w3","w4","w5"]}
Rules: perfect = exact vowel+consonant sound; near = very close; slant = consonant or approximate match. 5-8 single words per category. No duplicates across categories.`
    }]
  });

  const text = message.content[0]?.text?.trim() || '';
  let result = { perfect: [], near: [], slant: [] };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) result = { perfect: [], near: [], slant: [], ...JSON.parse(m[0]) };
  } catch { /* return empty result */ }

  return res.status(200).json(result);
};
