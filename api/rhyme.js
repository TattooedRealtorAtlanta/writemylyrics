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

  const body = await getJsonBody(req);
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
