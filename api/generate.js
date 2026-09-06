const Anthropic = require('@anthropic-ai/sdk');
const { supabase, PLAN_LIMITS, getUser, getProfile } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');
const { cancelEmail, sendSongEmail } = require('./_lib/resend');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-8';

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

  if (daysSinceReset >= 30 && profile.plan === 'free') {
    await supabase
      .from('profiles')
      .update({ usage_count: 0, usage_reset_at: now.toISOString() })
      .eq('id', user.id);
    currentUsage = 0;
  }

  // Enforce plan limit
  const limit = PLAN_LIMITS[profile.plan] ?? 5;
  if (currentUsage >= limit) {
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

  const { topic, genre, genres, moods, structure, tempo, rhyme, pov, words, styleNotes, language, mixLanguages, sectionLanguages, artistStyle, narrative } = body;
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  // Resolve genre display — narrative mode may pass a genres array
  const advGenres = Array.isArray(genres) && genres.length > 0 ? genres : null;
  const genreDisplay = advGenres
    ? advGenres.join(' + ')
    : (genre || 'Unspecified');

  // Detect if this is a rap/hip-hop track
  const allGenres = advGenres || (genre ? [genre] : []);
  const isRapTrack = allGenres.some(g => /rap|hip.?hop|trap/i.test(g));
  const rapInstruction = isRapTrack
    ? '\nRAP STRUCTURE NOTE: This is a Rap / Hip Hop track. Write VERSE sections as rap bars — strong multi-syllable rhyme schemes, internal rhymes, rhythm and flow, wordplay. The CHORUS/HOOK may be sung or rapped. Prioritize cadence, punch lines, and lyrical density over standard song structure.'
    : '';

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

  // Point of view — build a strong, explicit enforcement instruction, not just the raw value.
  // Models default to first person very readily, especially when working from a first-person
  // narrative brief, so a bare "Point of view: X" line is often not enough on its own.
  const povValue = pov || 'First person (I / me / my)';
  const povEmphasis = (() => {
    if (/third/i.test(povValue)) return 'Refer to the subject using "he", "she", "they", or their name/role — never "I", "me", "my", or "we". Write about them, not as them.';
    if (/second/i.test(povValue)) return 'Address the subject directly as "you" / "your" throughout — never "I", "me", or "my".';
    if (/shifting/i.test(povValue)) return 'Deliberately shift perspective across sections (e.g. first person in the verses, second person in the chorus) rather than staying in one voice the whole song.';
    return '';
  })();
  const povInstruction = povEmphasis
    ? `\n\nPOINT OF VIEW — NON-NEGOTIABLE: This song must be written in ${povValue}. ${povEmphasis} Re-read every line before finishing and rewrite any line that slips into the wrong point of view.`
    : '';

  let lyricsUsr;
  if (narrative) {
    // Advanced mode — treat the full input as a rich creative brief
    const genreLine = advGenres && advGenres.length > 1
      ? `Genre blend: ${genreDisplay} — weave elements of each style together naturally`
      : `Genre: ${genreDisplay}`;
    lyricsUsr = `Write complete song lyrics based on the following narrative from the songwriter:

---
${topic}
---

Use this narrative as your primary creative source. Pull specific details, emotions, images, and characters directly from it. If the narrative includes any lyric lines or partial verses, treat them as style and tone reference — match that voice. Let the story guide every word.

${genreLine}
${moods && moods.length ? `Mood: ${moodStr}\n` : ''}Structure: ${structure || 'Verse / Chorus / Verse / Chorus / Bridge / Chorus'}
Tempo: ${tempo || 'Mid tempo'}
Rhyme scheme: ${rhyme || 'Mixed, rhyme where it feels natural'}
Point of view: ${povValue}
${words ? `Words to include: ${words}\n` : ''}${styleNotes ? `Style notes: ${styleNotes}\n` : ''}${langInstruction}${povInstruction}

Write the complete lyrics now. Label every section. Stay true to the narrative.${artistStyle ? `\n\nARTIST STYLE: Write in the distinct lyrical style of ${artistStyle} — their characteristic vocabulary, rhyme patterns, phrasing, themes, and flow. The lyrics should sound like they could genuinely be from that artist.` : ''}${rapInstruction}`;
  } else {
    lyricsUsr = `Write complete song lyrics:

Topic: ${topic}
Genre: ${genre || 'Unspecified'}
Mood: ${moodStr}
Structure: ${structure || 'Verse / Chorus / Verse / Chorus / Bridge / Chorus'}
Tempo: ${tempo || 'Mid tempo'}
Rhyme scheme: ${rhyme || 'Mixed, rhyme where it feels natural'}
Point of view: ${povValue}
Words to include: ${words || 'None'}
Style notes: ${styleNotes || 'None'}${langInstruction}${povInstruction}

Write the complete lyrics now. Label every section. Make it authentic.${artistStyle ? `\n\nARTIST STYLE: Write in the distinct lyrical style of ${artistStyle} — their characteristic vocabulary, rhyme patterns, phrasing, themes, and flow. The lyrics should sound like they could genuinely be from that artist.` : ''}${rapInstruction}`;
  }

  const titlesSys = `You are a music title expert. Respond with ONLY a JSON array of exactly 3 title strings. No prose, no backticks, no markdown.`;
  const titlesUsr = narrative
    ? `Suggest 3 song titles based on this songwriter's narrative for a ${genreDisplay} song:\n${topic.slice(0, 300)}`
    : `Suggest 3 song titles for a ${genre || 'general'} song about: ${topic}${primaryLang !== 'English' ? `. Titles should be in ${primaryLang} or blend ${primaryLang} and English naturally.` : ''}`;

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
    const usageUpdate = { usage_count: newUsage };

    // First-ever generation — cancel the 48h nudge email, it's no longer needed
    if (currentUsage === 0 && profile.email_nudge_id) {
      cancelEmail(profile.email_nudge_id).catch(e =>
        console.warn('[generate] nudge cancel failed:', e.message)
      );
      usageUpdate.email_nudge_id = null;
    }

    await supabase
      .from('profiles')
      .update(usageUpdate)
      .eq('id', user.id);

    // Free plan has no in-app song history (Pro/Unlimited only), so without
    // this the song is gone the moment the tab closes. Email a copy so every
    // free user has something to come back to. Awaited (not fire-and-forget):
    // Vercel can freeze this function the instant the response is sent, which
    // silently kills any request still in flight that isn't part of the
    // awaited chain — a bare .catch() with no await here would drop the send.
    if (profile.plan === 'free') {
      try {
        await sendSongEmail(user.email, name, { title: titles?.[0] || null, lyrics, genre: genreDisplay });
      } catch (e) {
        console.warn('[generate] song email failed:', e.message);
      }
    }

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
