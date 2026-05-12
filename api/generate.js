const Anthropic = require('@anthropic-ai/sdk');
const { supabase, PLAN_LIMITS, getUser, getProfile } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const name = user.user_metadata?.name || user.user_metadata?.full_name;
  const profile = await getProfile(user.id, user.email, name);
  if (!profile) return res.status(500).json({ error: 'Profile not found' });

  // Monthly reset check
  const now = new Date();
  const resetAt = new Date(profile.usage_reset_at);
  const daysSinceReset = (now - resetAt) / (1000 * 60 * 60 * 24);
  let currentUsage = profile.usage_count;

  if (daysSinceReset >= 30 && profile.plan !== 'unlimited') {
    await supabase
      .from('profiles')
      .update({ usage_count: 0, usage_reset_at: now.toISOString() })
      .eq('id', user.id);
    currentUsage = 0;
  }

  // Enforce plan limit
  const limit = PLAN_LIMITS[profile.plan] ?? 5;
  if (profile.plan !== 'unlimited' && currentUsage >= limit) {
    return res.status(429).json({
      error: 'Monthly generation limit reached',
      plan: profile.plan,
      usage: currentUsage,
      limit
    });
  }

  // Parse request body
  let body;
  try {
    body = await getJsonBody(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { topic, genre, moods, structure, tempo, rhyme, pov, words, styleNotes, language, mixLanguages, sectionLanguages } = body;
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  const moodStr = Array.isArray(moods) ? moods.join(', ') : (moods || 'Unspecified');
  const primaryLang = language || 'English';
  const isMixed = !!(mixLanguages && sectionLanguages && Object.keys(sectionLanguages).length);

  // Build language instruction block
  let langInstruction = '';
  if (isMixed) {
    const assignments = Object.entries(sectionLanguages)
      .map(([sect, lang]) => `  ${sect} → ${lang}`)
      .join('\n');
    langInstruction = `\nLanguage: Mixed (per section — see below)\nPer-section language assignments:\n${assignments}\nIMPORTANT: Keep all section labels in English (VERSE 1, CHORUS, BRIDGE, etc.) but write the lyrics for each section in the language assigned to that section type. If a section type is not listed, write it in ${primaryLang}.`;
  } else if (primaryLang !== 'English') {
    langInstruction = `\nLanguage: Write ALL lyrics in ${primaryLang}. Keep section labels in English (VERSE 1, CHORUS, BRIDGE, etc.) but the lyric lines must be written in ${primaryLang}.`;
  }

  const lyricsSys = `You are an expert songwriter with deep knowledge of multiple genres and languages. You write authentic, emotionally resonant lyrics that sound like they came from a real artist. You understand meter, rhyme, imagery, and storytelling in any language. Always label each section clearly — VERSE 1, CHORUS, BRIDGE etc. Never add explanation or commentary — just the lyrics.`;

  const lyricsUsr = `Write complete song lyrics:

Topic: ${topic}
Genre: ${genre || 'Unspecified'}
Mood: ${moodStr}
Structure: ${structure || 'Verse / Chorus / Verse / Chorus / Bridge / Chorus'}
Tempo: ${tempo || 'Mid tempo'}
Rhyme scheme: ${rhyme || 'Mixed, rhyme where it feels natural'}
Point of view: ${pov || 'First person (I / me / my)'}
Words to include: ${words || 'None'}
Style notes: ${styleNotes || 'None'}${langInstruction}

Write the complete lyrics now. Label every section. Make it authentic.`;

  const titlesSys = `You are a music title expert. Respond with ONLY a JSON array of exactly 3 title strings. No prose, no backticks, no markdown.`;
  const titlesUsr = `Suggest 3 song titles for a ${genre || 'general'} song about: ${topic}${primaryLang !== 'English' ? `. Titles should be in ${primaryLang} or blend ${primaryLang} and English naturally.` : ''}`;

  const chordsSys = `You are a music theorist. Suggest chord progressions that real musicians use. Respond in EXACTLY the format requested — nothing else.`;
  const chordsUsr = `Chord progression for:
Genre: ${genre || 'Unspecified'}
Mood: ${moodStr}
Tempo: ${tempo || 'Mid tempo'}
Structure: ${structure || 'Verse / Chorus / Verse / Chorus / Bridge / Chorus'}

Respond EXACTLY:
KEY: [key]
STRUMMING: [pattern]

[section]: [chords with em dashes]
(one line per section)`;

  try {
    // Run all three Anthropic calls in parallel
    const [lyricsMsg, titlesMsg, chordsMsg] = await Promise.all([
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 2200,
        system: lyricsSys,
        messages: [{ role: 'user', content: lyricsUsr }]
      }),
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: titlesSys,
        messages: [{ role: 'user', content: titlesUsr }]
      }),
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: chordsSys,
        messages: [{ role: 'user', content: chordsUsr }]
      })
    ]);

    const lyrics = lyricsMsg.content[0].text;
    const chordsRaw = chordsMsg.content[0].text;

    // Parse titles
    let titles = [];
    try {
      const raw = titlesMsg.content[0].text;
      const m = raw.match(/\[[\s\S]*?\]/);
      if (m) titles = JSON.parse(m[0]);
    } catch { /* titles optional */ }

    // Increment usage (one count per full generation)
    const newUsage = currentUsage + 1;
    await supabase
      .from('profiles')
      .update({ usage_count: newUsage })
      .eq('id', user.id);

    return res.status(200).json({
      lyrics,
      titles,
      chords: chordsRaw,
      usage: newUsage,
      limit,
      plan: profile.plan
    });

  } catch (e) {
    console.error('Generate error:', e);
    return res.status(500).json({ error: e.message || 'Generation failed' });
  }
};
