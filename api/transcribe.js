if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}
const { getUser, getProfile } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_BYTES = 24 * 1024 * 1024; // 24 MB — Whisper hard limit is 25 MB

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function callWhisper(audioBuffer, audioType, audioName) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([audioBuffer], { type: audioType }),
    audioName
  );
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('timestamp_granularities[]', 'word');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Whisper API error (${res.status}): ${errText}`);
  }

  return res.json();
}

const handler = async function transcribeHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const profile = await getProfile(user.id, user.email, user.user_metadata?.name);
  if (profile.plan === 'free') {
    return res.status(403).json({ error: 'Karaoke requires Pro or Unlimited plan' });
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();

  let audioBuffer, audioType, audioName;

  // ── URL mode ── client sends { url } as JSON
  if (contentType.includes('application/json')) {
    let body;
    try { body = await getJsonBody(req); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const { url } = body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    let audioRes;
    try {
      audioRes = await fetch(url, { headers: { 'User-Agent': 'WriteMyLyrics/1.0' } });
    } catch (e) {
      return res.status(400).json({ error: 'Could not fetch audio URL: ' + e.message });
    }
    if (!audioRes.ok) {
      return res.status(400).json({ error: `Audio URL returned ${audioRes.status}` });
    }

    audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    audioType   = (audioRes.headers.get('content-type') || 'audio/mpeg').split(';')[0];
    audioName   = 'audio.mp3';

  // ── File upload mode ── client sends raw binary with audio/* content-type
  } else {
    audioBuffer = await readRawBody(req);
    audioType   = contentType.split(';')[0] || 'audio/mpeg';
    audioName   = req.headers['x-filename'] || 'audio.mp3';
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return res.status(400).json({ error: 'No audio data received' });
  }
  if (audioBuffer.length > MAX_BYTES) {
    return res.status(400).json({ error: 'Audio too large — max 24 MB' });
  }

  try {
    const data = await callWhisper(audioBuffer, audioType, audioName);

    console.log('[transcribe] raw text:', data.text);
    console.log('[transcribe] segments count:', (data.segments || []).length);
    console.log('[transcribe] words count:', (data.words || []).length);
    console.log('[transcribe] words:', JSON.stringify(data.words || [], null, 2));
    console.log('[transcribe] segments:', JSON.stringify((data.segments || []).map(s => ({
      start: s.start, end: s.end, text: s.text
    })), null, 2));

    return res.status(200).json({
      segments: data.segments || [],
      words:    data.words    || [],
      text:     data.text     || ''
    });
  } catch (e) {
    console.error('[transcribe]', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Disable Vercel's built-in body parser — we handle the stream ourselves
handler.config = { api: { bodyParser: false, sizeLimit: '25mb' } };

module.exports = handler;
