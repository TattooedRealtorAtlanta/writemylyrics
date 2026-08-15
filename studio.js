// Studio bundle — lazy-loaded on demand (see loadStudioBundle() in index.html)
// Contains everything specific to the logged-in Studio experience: song
// generation, rendering, history, karaoke, PDF/Suno export, chord tools,
// settings, templates, and the onboarding wizard. Split out of index.html
// so the homepage doesn't pay for parsing/executing it before a visitor
// ever logs in.
// ── KARAOKE STATE ──
const KAR = {
  lines: [],
  mode: 'sync',
  currentLine: -1,
  songId: null,
  audioUrl: '',   // set when URL is loaded
  audioFile: null // set when file is uploaded
};

const LOAD_MSGS = [
  'Finding the words...','Setting the scene...','Building the hook...',
  'Tuning the melody...','Searching for the chorus...','Laying down the verse...',
  'Getting into the groove...','Almost there...'
];
let loadTick = null, loadIdx = 0, genAbort = null;

// ── AUDIO URL SAVE ──
async function saveStudioAudioUrl() {
  if (!APP.currentSongId) return;
  const val = (document.getElementById('studioAudioUrl')?.value || '').trim();
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: APP.currentSongId, audio_url: val || null })
    });
    const idx = APP.songs.findIndex(s => s.id === APP.currentSongId);
    if (idx >= 0) APP.songs[idx].audio_url = val || null;
  } catch(e) {
    toast('Error saving audio URL: ' + e.message);
  }
}

async function saveHistoryAudioUrl(id, val) {
  val = (val || '').trim();
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id, audio_url: val || null })
    });
    const idx = APP.songs.findIndex(s => s.id === id);
    if (idx >= 0) APP.songs[idx].audio_url = val || null;
    // Keep studio input in sync if this is the currently loaded song
    if (APP.currentSongId === id) {
      const studioInput = document.getElementById('studioAudioUrl');
      if (studioInput) studioInput.value = val;
    }
  } catch(e) {
    toast('Error saving audio URL: ' + e.message);
  }
}

// ── GENERATE ──
async function generate() {
  // Cancel any in-flight generation before starting a new one
  if (genAbort) { genAbort.abort(); genAbort = null; }
  // If still marked busy after abort, reset so we can proceed
  APP.busy = false;

  const token = await getToken();
  if (!token) { showAuthTab('signin'); return; }

  let topic, payload;
  if (APP.advancedMode) {
    const narrative = document.getElementById('advNarrative').value.trim();
    if (!narrative) { toast('Tell us about your song first.'); return; }
    topic = narrative;
    payload = {
      topic: narrative,
      genre: APP.advGenres[0] || '',
      genres: APP.advGenres,
      moods: APP.moods,
      structure: document.getElementById('advStructure').value,
      tempo: APP.tempo,
      rhyme: document.getElementById('advRhyme').value,
      pov: document.getElementById('advPov').value,
      words: document.getElementById('advWords').value,
      styleNotes: document.getElementById('advTone').value,
      language: APP.language,
      mixLanguages: false,
      sectionLanguages: {},
      artistStyle: document.getElementById('advArtistStyleInput')?.value.trim() || '',
      narrative: true
    };
  } else {
    topic = document.getElementById('topic').value.trim();
    if (!topic) { toast('Please describe what your song is about.'); return; }
    payload = {
      topic,
      genre: APP.genre || '',
      genres: APP.advGenres.length ? APP.advGenres : (APP.genre ? [APP.genre] : []),
      moods: APP.moods,
      structure: document.getElementById('structure').value,
      tempo: APP.tempo,
      rhyme: document.getElementById('rhyme').value,
      pov: document.getElementById('pov').value,
      words: document.getElementById('words').value,
      styleNotes: document.getElementById('tone').value,
      language: APP.language,
      mixLanguages: APP.mixLanguages,
      sectionLanguages: APP.mixLanguages ? APP.sectionLanguages : {},
      artistStyle: document.getElementById('artistStyleInput')?.value.trim() || ''
    };
  }

  gaEvent('generate_clicked', { genre: payload.genre || (payload.genres && payload.genres[0]) || 'none' });

  genAbort = new AbortController();
  const signal = genAbort.signal;

  APP.busy = true;
  setLoading(true);
  tickLoader();

  try {
    const result = await authFetch('/api/generate', {
      method: 'POST',
      signal,
      body: JSON.stringify(payload)
    });

    APP.lyrics = result.lyrics;
    APP.originalLyrics = result.lyrics;
    APP.currentSongId = null;
    APP.artistStyle = (APP.advancedMode
      ? document.getElementById('advArtistStyleInput')?.value.trim()
      : document.getElementById('artistStyleInput')?.value.trim()) || '';
    APP.usage = result.usage;
    APP.totalSongs = (APP.totalSongs || 0) + 1;
    if (APP._firstSongPending) { APP._firstSongPending = false; setTimeout(launchConfetti, 400); }
    APP.limit = result.limit;
    APP.plan = result.plan;
    updateUsage();
    applyPlanUI();

    renderLyrics(result.lyrics);

    if (result.titles?.length) renderTitles(result.titles);
    if (result.chords) renderChords(result.chords);

    // Auto-save to history for pro/unlimited
    if (APP.plan !== 'free') {
      await saveSongToHistory(result);
    }

    // Reset refine state for fresh generation (panel visibility handled by renderLyrics)
    const rrBtn = document.getElementById('refineRevertBtn');
    if (rrBtn) rrBtn.classList.remove('on');
    const ri = document.getElementById('refineInstructions');
    if (ri) ri.value = '';

    gaEvent('generation_success', { genre: payload.genre || (payload.genres && payload.genres[0]) || 'none' });

  } catch (e) {
    // Aborted by a new generate() call — not a real error, new request handles its own UI
    if (e.name === 'AbortError') return;
    gaEvent('generation_error', { reason: String(e.message || 'unknown').slice(0, 100) });
    if (e.message !== 'Monthly limit reached') {
      toast('Error: ' + e.message);
    }
    setLoading(false);
  } finally {
    stopLoader();
    APP.busy = false;
    genAbort = null;
  }
}

// ── RENDER ──
function renderLyrics(text) {
  stopLoader();
  APP.busy = false;

  // Hide Write This Song and reset its state — Regenerate takes over from here
  const genBtn = document.getElementById('genBtn');
  if (genBtn) { genBtn.classList.remove('loading'); genBtn.disabled = false; genBtn.style.display = 'none'; }

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('loadState').classList.remove('on');
  document.getElementById('outContent').style.display = 'block';
  document.getElementById('rpActions').style.display = 'flex';

  // Always show the refine panel when lyrics are displayed — applyPlanUI handles lock state
  const rp = document.getElementById('refinePanel');
  if (rp) rp.classList.add('on');
  applyPlanUI();

  const topicRaw = APP.advancedMode
    ? document.getElementById('advNarrative').value.trim()
    : document.getElementById('topic').value.trim();
  const topicLabel = topicRaw.length > 50 ? topicRaw.slice(0, 50).replace(/\s\S*$/, '') + '…' : topicRaw;
  document.getElementById('rpLabel').textContent = topicLabel || 'Your lyrics';

  const out = document.getElementById('lyricsOut');
  out.innerHTML = '';
  out.classList.toggle('syl-on', !!APP.showSyllables);

  if (APP.showChords) {
    renderLyricsChordMode(text, out);
  } else {
    renderLyricsNormal(text, out);
  }

  // Stats
  const allLines = text.split('\n');
  const words = text.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).length;
  const lyricLines = allLines.filter(l => l.trim() && !/^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO)/i.test(l.trim())).length;
  document.getElementById('wc').textContent = words;
  document.getElementById('lc').textContent = lyricLines;
  document.getElementById('el').textContent = Math.round(lyricLines * 2.5 / 60 * 10) / 10 + ' min';

  document.getElementById('rpScroll').scrollTop = 0;
}

// Translate a section label keyword (VERSE→VERSO etc.) based on current UI language
function translateSectionLabel(label) {
  const lang = APP.uiLang || 'en';
  if (lang === 'en') return label;
  const map = {
    VERSE: t('section.verse'), CHORUS: t('section.chorus'), BRIDGE: t('section.bridge'),
    'PRE-CHORUS': t('section.prechorus'), 'PRE CHORUS': t('section.prechorus'),
    INTRO: t('section.intro'), OUTRO: t('section.outro'), HOOK: t('section.hook'), TAG: t('section.tag'),
  };
  return label.replace(/^(PRE-CHORUS|PRE CHORUS|VERSE|CHORUS|BRIDGE|INTRO|OUTRO|HOOK|TAG|REFRAIN)/i,
    m => map[m.toUpperCase()] || m);
}

// Normal lyrics render (no chords) — handles plain text and syllable mode
function renderLyricsNormal(text, out) {
  const lines = text.split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (APP.showSyllables) {
        const spacer = document.createElement('div');
        spacer.className = 'lyric-line-row spacer';
        out.appendChild(spacer);
      } else {
        out.appendChild(document.createTextNode('\n'));
      }
      return;
    }
    const innerLabel = trimmed.replace(/^\*{1,3}(.*)\*{1,3}$/, '$1').replace(/^\[(.*)\]$/, '$1').trim();
    const isLabel = /^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|PRE CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(innerLabel)
      || /^\*{1,3}.{1,40}\*{1,3}$/.test(trimmed)
      || /^\[.{1,40}\]$/.test(trimmed)
      || (/^[A-Z][A-Z\s\d\-\/]{1,24}$/.test(trimmed) && !/[a-z]/.test(trimmed) && trimmed.split(' ').length <= 4);
    if (isLabel) {
      const span = document.createElement('span');
      span.className = 'sec-label';
      span.textContent = translateSectionLabel(innerLabel || trimmed);
      out.appendChild(span);
    } else if (APP.showSyllables) {
      const row = document.createElement('div');
      row.className = 'lyric-line-row';
      const txt = document.createElement('span');
      txt.className = 'lyric-line-text';
      txt.textContent = line;
      const cnt = document.createElement('span');
      cnt.className = 'syl-count';
      cnt.textContent = countLineSyllables(line);
      row.appendChild(txt);
      row.appendChild(cnt);
      out.appendChild(row);
    } else {
      out.appendChild(document.createTextNode(line + '\n'));
    }
  });
}

// Chord-mode render — shows chord names above each lyric line (lead-sheet style)
function renderLyricsChordMode(text, out) {
  // Build flat chord list from all sections in order
  const chordList = [];
  if (APP.parsedChords) {
    for (const chords of Object.values(APP.parsedChords.sections)) {
      for (const c of chords) {
        chordList.push(APP.transposeOffset ? transposeChord(c, APP.transposeOffset) : c);
      }
    }
  }

  const lines = text.split('\n');
  let lyricIdx = 0;

  lines.forEach(line => {
    const trimmed = line.trim();

    // Blank line → small gap
    if (!trimmed) {
      const gap = document.createElement('div');
      gap.style.height = '10px';
      out.appendChild(gap);
      return;
    }

    // Section label — detect bare keywords, **bold**, [bracket], or all-caps short lines
    const innerText = trimmed.replace(/^\*{1,3}(.*)\*{1,3}$/, '$1').replace(/^\[(.*)\]$/, '$1').trim();
    const isLabel = /^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|PRE CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(innerText)
      || /^\*{1,3}.{1,40}\*{1,3}$/.test(trimmed)
      || /^\[.{1,40}\]$/.test(trimmed)
      || (/^[A-Z][A-Z\s\d\-\/]{1,24}$/.test(trimmed) && !/[a-z]/.test(trimmed) && trimmed.split(' ').length <= 4);
    if (isLabel) {
      const span = document.createElement('span');
      span.className = 'sec-label';
      span.textContent = translateSectionLabel(innerText || trimmed);
      out.appendChild(span);
      return; // do NOT increment lyricIdx
    }

    // Lyric line — wrap in a block with chord stacked above
    const block = document.createElement('div');
    block.style.cssText = 'margin-top:8px;line-height:1';

    if (chordList.length > 0) {
      const chordEl = document.createElement('div');
      chordEl.style.cssText = [
        'display:block',
        'font-family:"DM Mono",monospace',
        'font-size:11.5px',
        'font-weight:700',
        'color:#9a6010',
        'letter-spacing:.1em',
        'line-height:1.3',
        'margin-bottom:1px',
        'user-select:text'
      ].join(';');
      chordEl.textContent = chordList[lyricIdx % chordList.length];
      block.appendChild(chordEl);
    }

    const textEl = document.createElement('div');
    textEl.style.cssText = [
      'display:block',
      'color:#1a140e',
      'font-family:"DM Sans",sans-serif',
      'font-size:15px',
      'line-height:1.75'
    ].join(';');
    textEl.textContent = line;
    block.appendChild(textEl);

    out.appendChild(block);
    lyricIdx++;
  });
}

function renderTitles(titles) {
  const area = document.getElementById('titleArea');
  const chips = document.getElementById('titleChips');
  chips.innerHTML = '';
  titles.forEach(t => {
    const chip = document.createElement('button');
    chip.className = 't-chip';
    chip.textContent = t;
    chip.onclick = () => { navigator.clipboard.writeText(t); toast('Title copied!'); };
    chips.appendChild(chip);
  });
  area.style.display = 'block';
}

function renderChords(raw) {
  APP.rawChords = raw || '';
  APP.transposeOffset = 0;
  APP.parsedChords = parseChordData(raw);
  updateChordDisplay();
  const area = document.getElementById('chordsArea');
  if (APP.parsedChords && Object.keys(APP.parsedChords.sections).length) area.style.display = 'block';
  // Update transpose key display
  const keyEl = document.getElementById('trKeyDisplay');
  if (keyEl) keyEl.textContent = APP.parsedChords?.key || 'C';
}

function updateChordDisplay() {
  const disp = document.getElementById('chordsDisplay');
  if (!disp) return;
  disp.innerHTML = '';
  const raw = getTransposedChordsText();
  const lines = (raw || '').split('\n').filter(l => l.trim());
  const keyLabel = t('chord.key');
  const strumLabel = t('chord.strumming');
  lines.forEach(line => {
    if (line.startsWith('KEY:') || line.startsWith('STRUMMING:')) {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:12px;color:var(--text2);margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)';
      info.textContent = line.replace(/^KEY:/, keyLabel + ':').replace(/^STRUMMING:/, strumLabel + ':');
      disp.appendChild(info);
    } else if (line.includes(':')) {
      const row = document.createElement('div');
      row.className = 'chord-row';
      const [sect, ...rest] = line.split(':');
      const prog = rest.join(':').trim();
      row.innerHTML = `<span class="chord-sect">${sect.trim()}</span><span class="chord-prog">${prog}</span>`;
      disp.appendChild(row);
    }
  });
}

// ── UI HELPERS ──
function setLoading(on) {
  document.getElementById('emptyState').style.display = on ? 'none' : 'flex';
  document.getElementById('loadState').classList.toggle('on', on);
  document.getElementById('outContent').style.display = 'none';
  document.getElementById('rpActions').style.display = 'none';
  const btn = document.getElementById('genBtn');
  // Only show spinner on the button if it's currently visible (pre-first-generation)
  if (btn && btn.style.display !== 'none') {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }
}

function tickLoader() {
  loadIdx = 0;
  clearInterval(loadTick);
  loadTick = setInterval(() => {
    loadIdx = (loadIdx + 1) % LOAD_MSGS.length;
    const el = document.getElementById('loadMsg');
    if (el) el.textContent = LOAD_MSGS[loadIdx];
    const bm = document.getElementById('btnMsg');
    if (bm) bm.textContent = LOAD_MSGS[loadIdx];
  }, 2200);
}

function stopLoader() { clearInterval(loadTick); }

function startOver() {
  APP.lyrics = '';
  APP.originalLyrics = '';
  APP.currentSongId = null;
  closeShareDropdown();
  const lbl = document.getElementById('copyShareLinkLabel');
  if (lbl) lbl.textContent = 'Copy Link';
  document.getElementById('outContent').style.display = 'none';
  document.getElementById('rpActions').style.display = 'none';
  document.getElementById('emptyState').style.display = 'flex';
  const genBtn = document.getElementById('genBtn');
  if (genBtn) { genBtn.style.display = ''; genBtn.classList.remove('loading'); genBtn.disabled = false; }
  document.getElementById('rpLabel').textContent = t('rp.label');
  document.getElementById('loadState').classList.remove('on');
  document.getElementById('titleArea').style.display = 'none';
  document.getElementById('chordsArea').style.display = 'none';
  APP.rawChords = '';
  APP.parsedChords = null;
  APP.showChords = false;
  APP.transposeOffset = 0;
  const scb = document.getElementById('showChordsBtn');
  if (scb) { scb.classList.remove('on'); const tr = I18N[APP.uiLang]||I18N.en; scb.textContent = tr['chord.show_chords']||'Show Chords'; }
  const tc = document.getElementById('transposeCtrl');
  if (tc) tc.style.display = 'none';
  const cg = document.getElementById('chordGuide');
  if (cg) cg.style.display = 'none';
  const cpb = document.getElementById('chordProgressionBlock');
  if (cpb) cpb.style.display = 'block';
  const out = document.getElementById('lyricsOut');
  if (out) out.classList.remove('chord-mode');
  document.getElementById('sunoPanel').classList.remove('on');
  document.getElementById('refinePanel').classList.remove('on');
  hideNotesPanel();
  const versionsBtn = document.getElementById('versionsBtn');
  if (versionsBtn) versionsBtn.style.display = 'none';
}

function copyLyrics() {
  navigator.clipboard.writeText(APP.lyrics);
  toast('Lyrics copied to clipboard!');
}

function exportLyrics() {
  const blob = new Blob([APP.lyrics], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lyrics.txt';
  a.click();
  toast('Lyrics downloaded!');
}





// ── SHARE ──
function toggleShareDropdown(e) {
  e.stopPropagation();
  if (APP.plan === 'free') {
    // Show upgrade modal with share-specific message
    const p = document.querySelector('#featureUpgradeBg .modal-p');
    if (p) p.textContent = 'Share your song publicly — upgrade to Pro to get a shareable link.';
    showFeatureUpgrade();
    return;
  }
  if (!APP.currentSongId) { toast('Save your song first — generate a song and it will save automatically.'); return; }
  const dd = document.getElementById('shareDropdown');
  dd.classList.toggle('open');
}


function copyShareLink() {
  closeShareDropdown();
  if (!APP.currentSongId) { toast('No song loaded.'); return; }
  const url = `https://writemylyrics.ai/song/${APP.currentSongId}`;
  navigator.clipboard.writeText(url).then(() => {
    const label = document.getElementById('copyShareLinkLabel');
    if (label) { label.textContent = 'Copied! ✓'; setTimeout(() => { label.textContent = 'Copy Link'; }, 2000); }
    toast('Link copied!');
  }).catch(() => toast('Could not copy — check browser permissions.'));
}

function shareOnX() {
  closeShareDropdown();
  if (!APP.currentSongId) { toast('No song loaded.'); return; }
  const title = document.getElementById('rpLabel')?.textContent?.trim() || 'my song';
  const genre = APP.genre || 'original';
  const url = `https://writemylyrics.ai/song/${APP.currentSongId}`;
  const text = `Just wrote this song with AI 🎵 "${title}" — ${genre} / Try it free → ${url} #WriteMyLyrics #AIMusic`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}



// Apply locked/unlocked visual state to plan-gated UI elements
function applyPlanUI() {
  const free = APP.plan === 'free';
  const lock = document.getElementById('refineLock');
  if (lock) lock.style.display = free ? 'inline' : 'none';
  const gate = document.getElementById('refineGate');
  const form = document.getElementById('refineForm');
  if (gate) gate.style.display = free ? 'block' : 'none';
  if (form) form.style.display = free ? 'none' : 'block';
}

function toggleAdvGenre(v) {
  const idx = APP.advGenres.indexOf(v);
  if (idx > -1) {
    APP.advGenres.splice(idx, 1);
  } else {
    if (APP.advGenres.length >= 3) return;
    APP.advGenres.push(v);
  }
  renderAdvGenreTags();
}

function removeAdvGenre(v) {
  APP.advGenres = APP.advGenres.filter(g => g !== v);
  renderAdvGenreTags();
}

function renderAdvGenreTags() {
  const tagsEl = document.getElementById('advGenreTags');
  const grid = document.getElementById('advGenreGrid');
  if (!tagsEl || !grid) return;
  tagsEl.innerHTML = APP.advGenres.map(g =>
    `<span class="adv-genre-tag">${g}<button class="adv-genre-tag-x" onclick="removeAdvGenre('${g.replace(/'/g, "\\'")}')" title="Remove">×</button></span>`
  ).join('');
  const atMax = APP.advGenres.length >= 3;
  grid.querySelectorAll('.pick-btn').forEach(b => {
    const sel = APP.advGenres.includes(b.dataset.v);
    b.classList.toggle('on', sel);
    b.classList.toggle('adv-maxed', atMax && !sel);
  });
  APP.genre = APP.advGenres[0] || '';
}

// Keep both Mood grids (Simple + Advanced) visually in sync with shared APP.moods state
function syncMoodUI() {
  document.querySelectorAll('#moodGrid .mood-chip, #advMoodGrid .mood-chip').forEach(b => {
    b.classList.toggle('on', APP.moods.includes(b.dataset.v));
  });
}

// Keep both Tempo grids (Simple + Advanced) visually in sync with shared APP.tempo state
function syncTempoUI() {
  document.querySelectorAll('#tempoGrid .pick-btn, #advTempoGrid .pick-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.v === APP.tempo);
  });
}

function onAdvLanguageChange() {
  APP.language = document.getElementById('advLanguageSel').value;
}

// Read a field's value from whichever mode is active (Simple vs Advanced copy of the same field)
function activeVal(simpleId, advId) {
  return document.getElementById(APP.advancedMode ? advId : simpleId)?.value || '';
}

function setStudioMode(mode) {
  if (mode === 'advanced' && APP.plan === 'free') {
    document.getElementById('featureUpgradeBg').classList.add('on');
    return;
  }
  APP.advancedMode = (mode === 'advanced');
  document.getElementById('tabSimple').classList.toggle('active', !APP.advancedMode);
  document.getElementById('tabAdvanced').classList.toggle('active', APP.advancedMode);
  document.getElementById('simpleModeFields').style.display = APP.advancedMode ? 'none' : '';
  document.getElementById('advancedModeFields').classList.toggle('on', APP.advancedMode);
  // Sync genre and structure when entering advanced mode
  if (APP.advancedMode) {
    if (APP.genre && !APP.advGenres.includes(APP.genre)) APP.advGenres = [APP.genre];
    renderAdvGenreTags();
    document.getElementById('advStructure').value = document.getElementById('structure').value;
    // Sync fine-tune fields into Advanced's copies
    document.getElementById('advRhyme').value = document.getElementById('rhyme').value;
    document.getElementById('advPov').value = document.getElementById('pov').value;
    document.getElementById('advWords').value = document.getElementById('words').value;
    document.getElementById('advTone').value = document.getElementById('tone').value;
    document.getElementById('advArtistStyleInput').value = document.getElementById('artistStyleInput').value;
    document.getElementById('advLanguageSel').value = document.getElementById('languageSel').value;
    syncMoodUI();
    syncTempoUI();
    // Hide template button in advanced mode — it's simple-mode-oriented
    const tmpl = document.getElementById('tmplBtn');
    if (tmpl) tmpl.style.display = 'none';
  } else {
    const tmpl = document.getElementById('tmplBtn');
    if (tmpl) tmpl.style.display = '';
    const atMax = APP.advGenres.length >= 3;
    document.querySelectorAll('#genreGrid .pick-btn').forEach(x => {
      const sel = APP.advGenres.includes(x.dataset.v);
      x.classList.toggle('on', sel);
      x.classList.toggle('adv-maxed', atMax && !sel);
    });
    syncMoodUI();
    syncTempoUI();
  }
}

// ── SETTINGS ──

function openSettings() {
  if (!APP.user) { toast('Sign in to access settings.'); return; }
  const p = APP.profile || {};

  // Populate genre
  const sg = document.getElementById('setGenre');
  if (sg) sg.value = p.default_genre || '';

  // Populate mood chips
  const savedMoods = p.default_moods ? p.default_moods.split(',').map(s => s.trim()) : [];
  document.querySelectorAll('#setMoodGrid .settings-mood-chip').forEach(chip => {
    chip.classList.toggle('on', savedMoods.includes(chip.dataset.v));
  });

  // Populate tempo
  const st = document.getElementById('setTempo');
  if (st) st.value = p.default_tempo || '';

  // Populate structure
  const ss = document.getElementById('setStructure');
  if (ss) ss.value = p.default_structure || '';

  // Populate pov
  const sp = document.getElementById('setPov');
  if (sp) sp.value = p.default_pov || '';

  // Populate language
  const sl = document.getElementById('setLanguage');
  if (sl) sl.value = p.default_language || '';

  // Populate account fields
  const dn = document.getElementById('setDisplayName');
  if (dn) dn.value = p.name || '';

  const em = document.getElementById('setEmail');
  if (em) em.value = p.email || APP.user.email || '';

  // Plan badge + upgrade button
  const badge = document.getElementById('setPlanBadge');
  const upgradeBtn = document.getElementById('setPlanUpgradeBtn');
  const plan = APP.plan || 'free';
  if (badge) badge.textContent = (plan === 'pro' || plan === 'unlimited') ? 'Pro' : 'Free';
  if (upgradeBtn) {
    if (plan === 'pro' || plan === 'unlimited') {
      upgradeBtn.style.display = 'none';
    } else {
      upgradeBtn.style.display = 'inline-block';
      upgradeBtn.textContent = 'Upgrade to Pro';
      upgradeBtn.onclick = () => { closeModal('settingsBg'); showPricing(); };
    }
  }

  document.getElementById('settingsSavingMsg').style.display = 'none';
  document.getElementById('settingsBg').classList.add('on');
}

function toggleSettingsMood(chip) {
  chip.classList.toggle('on');
}

async function saveSettings() {
  if (!APP.user) return;
  const savingMsg = document.getElementById('settingsSavingMsg');
  savingMsg.style.display = 'inline';

  const selectedMoods = [...document.querySelectorAll('#setMoodGrid .settings-mood-chip.on')]
    .map(c => c.dataset.v);

  const body = {
    display_name:      document.getElementById('setDisplayName').value.trim(),
    default_genre:     document.getElementById('setGenre').value || null,
    default_moods:     selectedMoods.length ? selectedMoods.join(',') : null,
    default_tempo:     document.getElementById('setTempo').value || null,
    default_structure: document.getElementById('setStructure').value || null,
    default_pov:       document.getElementById('setPov').value || null,
    default_language:  document.getElementById('setLanguage').value || null,
  };

  try {
    const updated = await authFetch('/api/user', { method: 'PATCH', body: JSON.stringify(body) });
    // Merge into APP.profile
    APP.profile = { ...APP.profile, ...updated };
    if (updated.name) APP.profile.name = updated.name;
    // Update avatar initial
    const av = document.getElementById('sbAvatar');
    if (av && updated.name) av.textContent = updated.name.charAt(0).toUpperCase();
    savingMsg.style.display = 'none';
    closeModal('settingsBg');
    toast('Settings saved.');
  } catch (e) {
    savingMsg.style.display = 'none';
    toast('Save failed — ' + e.message);
  }
}

// Apply saved defaults to studio fields when a user logs in
function applyStudioDefaults(profile) {
  if (!profile) return;

  // Genre
  if (profile.default_genre) {
    document.querySelectorAll('#genreGrid .pick-btn').forEach(b => {
      const isMatch = b.classList.toggle('on', b.dataset.v === profile.default_genre);
    });
    APP.genre = profile.default_genre;
  }

  // Moods
  if (profile.default_moods) {
    const moods = profile.default_moods.split(',').map(s => s.trim());
    document.querySelectorAll('#moodGrid .mood-chip').forEach(b => {
      if (moods.includes(b.dataset.v)) {
        b.classList.add('on');
      }
    });
    APP.moods = moods;
  }

  // Tempo
  if (profile.default_tempo) {
    document.querySelectorAll('#tempoGrid .pick-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.v === profile.default_tempo);
    });
    APP.tempo = profile.default_tempo;
  }

  // Structure
  if (profile.default_structure) {
    const sel = document.getElementById('structure');
    if (sel) sel.value = profile.default_structure;
  }

  // POV
  if (profile.default_pov) {
    const sel = document.getElementById('pov');
    if (sel) sel.value = profile.default_pov;
  }

  // Language
  if (profile.default_language) {
    const sel = document.getElementById('languageSel');
    if (sel) {
      sel.value = profile.default_language;
      APP.language = profile.default_language;
      if (typeof onLanguageChange === 'function') onLanguageChange();
    }
  }
}

// ── TEMPLATES ──
const TEMPLATES = [
  { name:'Classic Country Ballad', emoji:'🤠', genre:'Country', moods:['Nostalgic','Melancholy','Tender'], tempo:'Slow ballad', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'ABCB ballad style', pov:'First person (I / me / my)', styleNotes:'Storytelling, vivid small-town imagery, plain honest language, earned emotion' },
  { name:'Trap Anthem', emoji:'🔥', genre:'Trap', moods:['Defiant','Raw'], tempo:'Driving fast', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'AABB couplets', pov:'First person (I / me / my)', styleNotes:'Short punchy lines, internal rhyme, repetition in hook, hustle and ambition themes' },
  { name:'Rock Anthem', emoji:'🎸', genre:'Rock', moods:['Defiant','Energetic'], tempo:'Driving fast', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'ABAB alternating', pov:'First person (I / me / my)', styleNotes:'Big chorus, power chords, anthemic feel, crowd-ready hook' },
  { name:'Pop Love Song', emoji:'💛', genre:'Pop', moods:['Happy','Tender','Hopeful'], tempo:'Uptempo', structure:'Intro / Verse / Pre-Chorus / Chorus / Verse / Pre-Chorus / Chorus / Bridge / Chorus', rhyme:'AABB couplets', pov:'First person (I / me / my)', styleNotes:'Catchy and radio-friendly, universal emotion, strong pre-chorus build' },
  { name:'R&B Love Song', emoji:'💛', genre:'R&B', moods:['Romantic','Tender'], tempo:'Mid tempo', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'ABAB alternating', pov:'First person (I / me / my)', styleNotes:'Smooth delivery, emotional runs, sensual imagery, intimate tone' },
  { name:'Outlaw Country Story', emoji:'🤠', genre:'Outlaw Country', moods:['Defiant','Reflective'], tempo:'Mid tempo', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'AABB couplets', pov:'First person (I / me / my)', styleNotes:'Gritty storytelling, anti-hero narrator, dust and whiskey imagery, earned world-weariness' },
  { name:'Military / Patriotic', emoji:'🎖️', genre:'Military / Patriotic', moods:['Defiant','Reflective','Nostalgic'], tempo:'Mid tempo', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'ABAB alternating', pov:'First person (I / me / my)', styleNotes:'Respectful and earned, grounded in real sacrifice and service, not clichéd flag-waving' },
  { name:'Blues Standard', emoji:'🎸', genre:'Blues', moods:['Sad','Raw','Melancholy'], tempo:'Slow ballad', structure:'Verse / Verse / Chorus / Verse / Chorus', rhyme:'AABB couplets', pov:'First person (I / me / my)', styleNotes:'Call and response feel, repeated lines with variation, world-weariness, understated emotion' },
  { name:'Latin / Reggaeton', emoji:'🔥', genre:'Latin', moods:['Celebratory','Energetic'], tempo:'Driving fast', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'AABB couplets', pov:'First person (I / me / my)', styleNotes:'Bilingual friendly, danceable rhythm, street romance, confident energy' },
  { name:'Singer-Songwriter Confessional', emoji:'✍️', genre:'Singer-Songwriter', moods:['Reflective','Melancholy','Raw'], tempo:'Slow ballad', structure:'Verse / Chorus / Verse / Chorus / Bridge / Chorus', rhyme:'Mixed, rhyme where it feels natural', pov:'First person (I / me / my)', styleNotes:'Intimate and personal, conversational, specific details over general statements' }
];

function openTemplates() {
  const grid = document.getElementById('tmplGrid');
  grid.innerHTML = '';
  TEMPLATES.forEach((t, i) => {
    const card = document.createElement('button');
    card.className = 'tmpl-card';
    const moodStr = t.moods.slice(0, 2).join(', ');
    card.innerHTML = `<div class="tmpl-card-name">${t.emoji} ${escHtml(t.name)}</div><div class="tmpl-card-meta">${escHtml(t.genre)} · ${escHtml(t.tempo)}<br>${escHtml(moodStr)}</div>`;
    card.onclick = () => applyTemplate(i);
    grid.appendChild(card);
  });
  document.getElementById('tmplBg').classList.add('on');
}

function closeTemplates() {
  document.getElementById('tmplBg').classList.remove('on');
}

function bgCloseTmpl(e) {
  if (e.target.id === 'tmplBg') closeTemplates();
}

function applyTemplate(idx) {
  const t = TEMPLATES[idx];

  // Genre
  document.querySelectorAll('#genreGrid .pick-btn').forEach(b => b.classList.toggle('on', b.dataset.v === t.genre));
  APP.genre = t.genre;

  // Moods
  document.querySelectorAll('#moodGrid .mood-chip').forEach(b => b.classList.toggle('on', t.moods.includes(b.dataset.v)));
  APP.moods = [...t.moods];

  // Tempo
  document.querySelectorAll('#tempoGrid .pick-btn').forEach(b => b.classList.toggle('on', b.dataset.v === t.tempo));
  APP.tempo = t.tempo;

  // Selects
  const trySet = (id, val) => { const el = document.getElementById(id); if (el) { for (const o of el.options) { if (o.value === val) { el.value = val; break; } } } };
  trySet('structure', t.structure);
  trySet('rhyme', t.rhyme);
  trySet('pov', t.pov);

  // Style notes
  document.getElementById('tone').value = t.styleNotes;

  closeTemplates();
  toast(`Template applied: ${t.name}`);
}

// ── RHYME ASSISTANT ──
function toggleRhymeAssist() {
  const toggle = document.getElementById('rhymeToggle');
  const body   = document.getElementById('rhymeBody');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
  if (!isOpen) document.getElementById('rhymeWord').focus();
}

async function submitRhyme() {
  const word = document.getElementById('rhymeWord').value.trim();
  if (!word) return;
  const btn = document.getElementById('rhymeFindBtn');
  btn.disabled = true;
  btn.textContent = '...';
  document.getElementById('rhymeResults').innerHTML = '<div class="rhyme-empty">Finding rhymes...</div>';
  try {
    const data = await authFetch('/api/rhyme', { method: 'POST', body: JSON.stringify({ word }) });
    renderRhymes(data, word, 'rhymeResults');
  } catch (e) {
    document.getElementById('rhymeResults').innerHTML = `<div class="rhyme-empty">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find';
  }
}

function toggleAdvFineTune() {
  const toggle = document.getElementById('advFineTuneToggle');
  const body   = document.getElementById('advFineTuneBody');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
}

function toggleAdvRhymeAssist() {
  const toggle = document.getElementById('advRhymeToggle');
  const body   = document.getElementById('advRhymeBody');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
  if (!isOpen) document.getElementById('advRhymeWord').focus();
}

async function submitAdvRhyme() {
  const word = document.getElementById('advRhymeWord').value.trim();
  if (!word) return;
  const btn = document.getElementById('advRhymeFindBtn');
  btn.disabled = true;
  btn.textContent = '...';
  document.getElementById('advRhymeResults').innerHTML = '<div class="rhyme-empty">Finding rhymes...</div>';
  try {
    const data = await authFetch('/api/rhyme', { method: 'POST', body: JSON.stringify({ word }) });
    renderRhymes(data, word, 'advRhymeResults');
  } catch (e) {
    document.getElementById('advRhymeResults').innerHTML = `<div class="rhyme-empty">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find';
  }
}

function renderRhymes(data, word, containerId) {
  const container = document.getElementById(containerId || 'rhymeResults');
  container.innerHTML = '';
  const cats = [
    { key: 'perfect', label: 'Perfect Rhymes' },
    { key: 'near',    label: 'Near Rhymes' },
    { key: 'slant',   label: 'Slant Rhymes' }
  ];
  let anyResults = false;
  cats.forEach(({ key, label }) => {
    const words = data[key] || [];
    if (!words.length) return;
    anyResults = true;
    const cat = document.createElement('div');
    cat.className = 'rhyme-category';
    const lbl = document.createElement('span');
    lbl.className = 'rhyme-cat-label';
    lbl.textContent = label;
    cat.appendChild(lbl);
    const ww = document.createElement('div');
    ww.className = 'rhyme-words';
    words.forEach(w => {
      const btn = document.createElement('button');
      btn.className = 'rhyme-word';
      btn.textContent = w;
      btn.onclick = () => { navigator.clipboard.writeText(w); toast(`"${w}" copied!`); };
      ww.appendChild(btn);
    });
    cat.appendChild(ww);
    container.appendChild(cat);
  });
  if (!anyResults) container.innerHTML = `<div class="rhyme-empty">No rhymes found for "${escHtml(word)}"</div>`;
}

// ── SYLLABLE COUNTER ──
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  // Remove trailing silent e (not le)
  word = word.replace(/([^aeiou])e$/, '$1');
  const matches = word.match(/[aeiouy]+/g);
  return Math.max(1, matches ? matches.length : 1);
}

function countLineSyllables(line) {
  return line.split(/\s+/).filter(Boolean).reduce((sum, w) => sum + countSyllables(w), 0);
}

function toggleSyllables() {
  APP.showSyllables = !APP.showSyllables;
  document.getElementById('syllableBtn').classList.toggle('gold', APP.showSyllables);
  if (APP.lyrics) renderLyrics(APP.lyrics);
}

// ── PDF EXPORT ──
function downloadPDF() {
  if (!APP.lyrics) { toast('Generate a song first.'); return; }
  if (!window.jspdf) { toast('PDF library not loaded — please refresh the page.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const ML = 20, MR = 20, MT = 20;
  const PW = 210, PH = 297;
  const CW = PW - ML - MR;
  let y = MT;

  const newPage = () => { doc.addPage(); y = MT; };
  const checkY = (need) => { if (y + need > PH - 18) newPage(); };

  // Title
  const titleText = document.getElementById('rpLabel').textContent || 'Untitled';
  doc.setFont('times', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(20, 10, 5);
  doc.text(titleText, ML, y);
  y += 10;

  // Metadata
  const metaParts = [APP.genre, APP.moods.join(', '), APP.tempo, APP.language !== 'English' ? APP.language : ''].filter(Boolean);
  if (APP.artistStyle) metaParts.push(`Style: ${APP.artistStyle}`);
  if (metaParts.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110, 90, 60);
    doc.text(metaParts.join('  ·  '), ML, y);
    y += 5;
  }

  // Divider
  y += 3;
  doc.setDrawColor(200, 170, 110);
  doc.line(ML, y, PW - MR, y);
  y += 8;
  doc.setTextColor(20, 10, 5);

  // Lyrics
  APP.lyrics.split('\n').forEach(line => {
    const t = line.trim();
    if (!t) { y += 3; return; }
    const isLabel = /^\[?(?:VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(t);
    if (isLabel) {
      checkY(10);
      y += 3;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(130, 90, 20);
      doc.text(t.toUpperCase(), ML, y);
      doc.setTextColor(20, 10, 5);
      y += 6;
    } else {
      const wrapped = doc.splitTextToSize(line, CW);
      wrapped.forEach(wl => {
        checkY(6);
        doc.setFont('courier', 'normal');
        doc.setFontSize(11);
        doc.text(wl, ML, y);
        y += 5.8;
      });
    }
  });

  // Chords
  const chordsEl = document.getElementById('chordsArea');
  if (chordsEl && chordsEl.style.display !== 'none') {
    checkY(20);
    y += 6;
    doc.setDrawColor(200, 170, 110);
    doc.line(ML, y, PW - MR, y);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(130, 90, 20);
    doc.text('CHORD PROGRESSION', ML, y);
    doc.setTextColor(20, 10, 5);
    y += 6;
    document.getElementById('chordsDisplay').childNodes.forEach(el => {
      const txt = el.textContent?.trim();
      if (!txt) return;
      checkY(6);
      doc.setFont('courier', 'normal');
      doc.setFontSize(10);
      doc.text(txt, ML, y);
      y += 5.5;
    });
  }

  // Footer on every page
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(160);
    doc.text('writemylyrics.ai', ML, PH - 10);
    if (total > 1) doc.text(`${i} / ${total}`, PW - MR, PH - 10, { align: 'right' });
  }

  const slug = (titleText.replace(/[^a-z0-9\s]/gi, '').trim() || 'lyrics').replace(/\s+/g, '-').toLowerCase();
  doc.save(`${slug}.pdf`);
  toast('PDF downloaded!');
}

// ── NOTES ──
let _notesSaveTimer = null;

function showNotesPanel(song) {
  const panel = document.getElementById('notesPanel');
  const ta    = document.getElementById('notesText');
  const sel   = document.getElementById('studioStatusSel');
  const badge = document.getElementById('rpStatus');
  ta.value = song.notes || '';
  const status = song.status || 'draft';
  if (sel) {
    sel.value = status;
    sel.className = `status-sel${status !== 'draft' ? ' s-' + status : ''}`;
  }
  if (badge) {
    badge.textContent = statusLabel(status);
    badge.className = `status-badge status-${status}`;
    badge.style.display = 'inline-flex';
  }
  panel.classList.add('on');
  document.getElementById('notesSaveStatus').textContent = '';

  // Audio URL row
  const audioRow = document.getElementById('notesAudioRow');
  const audioInput = document.getElementById('studioAudioUrl');
  if (audioRow && audioInput) {
    audioRow.style.display = 'block';
    audioInput.value = (song && song.audio_url) || '';
  }

  // Publish row
  const pubRow = document.getElementById('notesPubRow');
  const pubBtn = document.getElementById('notesPubBtn');
  if (pubRow && pubBtn) {
    pubRow.style.display = 'flex';
    setPublishBtn(pubBtn, !!(song && song.published));
  }
}

function hideNotesPanel() {
  document.getElementById('notesPanel').classList.remove('on');
  const audioRow = document.getElementById('notesAudioRow');
  if (audioRow) audioRow.style.display = 'none';
  const pubRow = document.getElementById('notesPubRow');
  if (pubRow) pubRow.style.display = 'none';
  const badge = document.getElementById('rpStatus');
  if (badge) badge.style.display = 'none';
}

function onNotesInput() {
  document.getElementById('notesSaveStatus').textContent = 'Unsaved';
  clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(() => {
    saveNotes(document.getElementById('notesText').value);
  }, 1500);
}

async function saveNotes(val) {
  if (!APP.currentSongId) return;
  document.getElementById('notesSaveStatus').textContent = 'Saving...';
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: APP.currentSongId, notes: val })
    });
    const idx = getCurrentSongIdx();
    if (idx >= 0) APP.songs[idx].notes = val;
    document.getElementById('notesSaveStatus').textContent = 'Saved';
    setTimeout(() => {
      const el = document.getElementById('notesSaveStatus');
      if (el && el.textContent === 'Saved') el.textContent = '';
    }, 2500);
  } catch {
    document.getElementById('notesSaveStatus').textContent = 'Error saving';
  }
}

// ── STATUS ──
function statusLabel(s) {
  const map = { draft: t('status.draft'), 'in-progress': t('status.in_progress'), 'sent-to-suno': t('status.sent_to_suno'), published: t('status.published') };
  return map[s] || t('status.draft');
}

function getCurrentSongIdx() {
  if (!APP.currentSongId) return -1;
  return APP.songs.findIndex(s => s.id === APP.currentSongId);
}

async function updateCurrentSongStatus(status, sel) {
  if (!APP.currentSongId) return;
  if (sel) sel.className = `status-sel${status !== 'draft' ? ' s-' + status : ''}`;
  const badge = document.getElementById('rpStatus');
  if (badge) {
    badge.textContent = statusLabel(status);
    badge.className = `status-badge status-${status}`;
  }
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: APP.currentSongId, status })
    });
    const idx = getCurrentSongIdx();
    if (idx >= 0) APP.songs[idx].status = status;
    // Sync history item select if visible
    const histSel = document.getElementById(`status-sel-${APP.currentSongId}`);
    if (histSel) {
      histSel.value = status;
      histSel.className = `status-sel${status !== 'draft' ? ' s-' + status : ''}`;
    }
  } catch (e) {
    toast('Error updating status: ' + e.message);
  }
}

async function updateSongStatus(songId, status, idx, sel) {
  if (sel) sel.className = `status-sel${status !== 'draft' ? ' s-' + status : ''}`;
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: songId, status })
    });
    if (APP.songs[idx]) APP.songs[idx].status = status;
    // Sync studio badge if this is the currently loaded song
    if (APP.currentSongId === songId) {
      const badge = document.getElementById('rpStatus');
      if (badge) { badge.textContent = statusLabel(status); badge.className = `status-badge status-${status}`; }
      const studioSel = document.getElementById('studioStatusSel');
      if (studioSel) { studioSel.value = status; studioSel.className = `status-sel${status !== 'draft' ? ' s-' + status : ''}`; }
    }
  } catch (e) {
    toast('Error updating status: ' + e.message);
  }
}

// ── VERSION HISTORY ──
let _verCurrentSongId = null;
let _selectedVersion  = null;

async function openVersionHistory(songId) {
  if (!songId) { toast('No song loaded — generate or load a song first.'); return; }
  _verCurrentSongId = songId;
  _selectedVersion  = null;

  const idx = APP.songs.findIndex(s => s.id === songId);
  const title = idx >= 0 ? (APP.songs[idx].title || APP.songs[idx].topic || 'Untitled') : '';
  document.getElementById('verSongTitle').textContent = title ? `"${title}"` : '';
  document.getElementById('verList').innerHTML    = '<div class="ver-loading">Loading versions...</div>';
  document.getElementById('verPreview').value     = '';
  document.getElementById('verRestoreBtn').classList.remove('on');
  document.getElementById('verOverlay').classList.add('on');

  try {
    const { versions } = await authFetch(`/api/versions?songId=${songId}`);
    renderVersionList(versions, songId);
  } catch (e) {
    document.getElementById('verList').innerHTML = `<div class="ver-empty">Could not load versions: ${escHtml(e.message)}</div>`;
  }
}

function closeVersionHistory() {
  document.getElementById('verOverlay').classList.remove('on');
  _verCurrentSongId = null;
  _selectedVersion  = null;
}

function renderVersionList(versions, songId) {
  const list = document.getElementById('verList');
  list.innerHTML = '';
  if (!versions.length) {
    list.innerHTML = '<div class="ver-empty">No versions saved yet.<br><br>Use Tweak &amp; Refine to automatically save a version each time you modify your lyrics.</div>';
    return;
  }
  versions.forEach(v => {
    const item = document.createElement('div');
    item.className = 'ver-item';
    const d = new Date(v.created_at);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const firstLine = v.lyrics.split('\n').find(l => l.trim() && !/^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK)/i.test(l.trim())) || '';
    item.innerHTML = `
      <div class="ver-item-date">${dateStr} at ${timeStr}</div>
      <div class="ver-item-preview">${escHtml(firstLine.substring(0, 65))}${firstLine.length > 65 ? '…' : ''}</div>`;
    item.onclick = () => selectVersion(v, item, songId);
    list.appendChild(item);
  });
}

function selectVersion(version, itemEl, songId) {
  _selectedVersion = version;
  document.querySelectorAll('.ver-item').forEach(el => el.classList.remove('selected'));
  itemEl.classList.add('selected');
  document.getElementById('verPreview').value = version.lyrics;
  const btn = document.getElementById('verRestoreBtn');
  btn.classList.add('on');
  btn.onclick = () => restoreVersion(version, songId);
}

async function restoreVersion(version, songId) {
  if (!confirm('Restore this version? A copy of your current lyrics will be saved first.')) return;

  // Save current lyrics as a version before restoring
  if (APP.lyrics) {
    try {
      await authFetch('/api/versions', {
        method: 'POST',
        body: JSON.stringify({ songId, lyrics: APP.lyrics })
      });
    } catch { /* best effort */ }
  }

  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: songId, lyrics: version.lyrics })
    });
    APP.lyrics = version.lyrics;
    APP.originalLyrics = version.lyrics;
    renderLyrics(version.lyrics);

    const idx = getCurrentSongIdx();
    if (idx >= 0) APP.songs[idx].lyrics = version.lyrics;

    closeVersionHistory();
    toast('Version restored!');
  } catch (e) {
    toast('Error restoring: ' + e.message);
  }
}

// ── LANGUAGE ──
const LANGUAGES = ['English','Spanish','French','Portuguese','German','Italian','Japanese','Korean','Arabic','Hindi'];

function onLanguageChange() {
  const sel = document.getElementById('languageSel');
  APP.language = sel.value;
  const mixField = document.getElementById('mixLangField');
  if (APP.language !== 'English') {
    mixField.style.display = 'block';
  } else {
    mixField.style.display = 'none';
    // Reset mix state
    APP.mixLanguages = false;
    APP.sectionLanguages = {};
    document.getElementById('mixSwitch').classList.remove('on');
    document.getElementById('sectionLangGrid').style.display = 'none';
  }
}

function toggleMixLanguages() {
  APP.mixLanguages = !APP.mixLanguages;
  document.getElementById('mixSwitch').classList.toggle('on', APP.mixLanguages);
  const grid = document.getElementById('sectionLangGrid');
  if (APP.mixLanguages) {
    buildSectionLangGrid();
    grid.style.display = 'grid';
  } else {
    grid.style.display = 'none';
    APP.sectionLanguages = {};
  }
}

function buildSectionLangGrid() {
  const structureVal = document.getElementById('structure').value;
  // Parse unique section types from structure string
  const parts = structureVal.split('/').map(s => s.trim().replace(/\s*\(.*\)/, '').trim());
  const seen = new Set();
  const sections = [];
  for (const p of parts) {
    // Normalize: "Verse 1", "Verse 2" → "Verse"; "Pre-Chorus" stays
    const base = p.replace(/\s+\d+$/, '').trim();
    if (base && !seen.has(base)) { seen.add(base); sections.push(base); }
  }

  const grid = document.getElementById('sectionLangGrid');
  grid.innerHTML = '';

  sections.forEach(sect => {
    const item = document.createElement('div');
    item.className = 'section-lang-item';
    const lbl = document.createElement('div');
    lbl.className = 'section-lang-label';
    lbl.textContent = sect;
    const sel = document.createElement('select');
    sel.id = `slang-${sect.replace(/\s+/g, '-')}`;
    // Default: primary language for the non-English language, English for others
    const defaultLang = APP.language;
    LANGUAGES.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      if (lang === defaultLang) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      APP.sectionLanguages[sect] = sel.value;
    });
    // Init default
    APP.sectionLanguages[sect] = defaultLang;
    item.appendChild(lbl);
    item.appendChild(sel);
    grid.appendChild(item);
  });
}

// ── VIEW SWITCHING ──
function showView(v) {
  const leftPanel = document.querySelector('.left-panel');
  const historyPanel = document.getElementById('historyPanel');
  const sbStudio = document.getElementById('sbStudio');
  const sbHistory = document.getElementById('sbHistory');

  if (v === 'history') {
    leftPanel.style.display = 'none';
    historyPanel.classList.add('active');
    sbStudio.classList.remove('active');
    sbHistory.classList.add('active');
    loadHistory();
    gaPageView('History', '/history');
  } else {
    leftPanel.style.display = '';
    historyPanel.classList.remove('active');
    sbStudio.classList.add('active');
    sbHistory.classList.remove('active');
    gaPageView('Studio', '/studio');
    gaEvent('view_studio');
  }
}

// ── HISTORY ──
function planGateEl(feature, text) {
  const div = document.createElement('div');
  div.className = 'plan-gate';
  div.innerHTML = `<div class="plan-gate-h">${escHtml(feature)}</div><div class="plan-gate-p">${escHtml(text)}</div><div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="plan-gate-btn" onclick="showFeatureUpgrade()">Upgrade Now</button></div>`;
  return div;
}


async function loadHistory() {
  const scroll = document.getElementById('hpScroll');
  scroll.innerHTML = '<div class="hi-loading">Loading songs...</div>';

  if (APP.plan === 'free') {
    scroll.innerHTML = `
      <div class="plan-gate">
        <div class="plan-gate-h">Song History</div>
        <div class="plan-gate-p">Your songs aren't being saved. Upgrade to automatically save every song, publish to the gallery, and unlock these features:</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:16px">
          <button class="hi-btn locked" onclick="showFeatureUpgrade()">🎤 Karaoke</button>
          <button class="hi-btn locked" onclick="showFeatureUpgrade()">📤 Publish</button>
          <button class="hi-btn locked" onclick="showFeatureUpgrade()">👥 Co-writers</button>
          <button class="hi-btn locked" onclick="showFeatureUpgrade()">💡 Suggestions</button>
        </div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="plan-gate-btn" onclick="showFeatureUpgrade()">Upgrade Now</button>
        </div>
      </div>`;
    return;
  }

  try {
    const { songs } = await authFetch('/api/songs');
    APP.songs = songs;

    // Also fetch songs this user is a co-writer on
    try {
      const cw = await authFetch('/api/cowrite?mine=true');
      APP.cowriteSongs = cw.songs || [];
    } catch { APP.cowriteSongs = []; }

    renderHistory(songs);
  } catch (e) {
    scroll.innerHTML = `<div class="hi-empty">Could not load songs: ${escHtml(e.message)}</div>`;
  }
}

function renderHistory(songs) {
  const scroll = document.getElementById('hpScroll');
  scroll.innerHTML = '';

  if (!songs.length) {
    scroll.innerHTML = '<div class="hi-empty">No songs saved yet.<br>Generate a song to get started!</div>';
    return;
  }

  songs.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const date   = new Date(song.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const genre  = song.genre || 'Unknown genre';
    const title  = song.title || song.topic || 'Untitled Song';
    const status = song.status || 'draft';
    const selCls = status !== 'draft' ? ` s-${status}` : '';
    const notesPrev = song.notes ? `<div class="hi-notes-preview">${escHtml(song.notes.substring(0, 80))}${song.notes.length > 80 ? '…' : ''}</div>` : '';
    item.innerHTML = `
      <div class="hi-title">${escHtml(title)}</div>
      <div class="hi-status-row">
        <select class="status-sel${selCls}" id="status-sel-${song.id}" onchange="updateSongStatus('${song.id}', this.value, ${idx}, this)">
          <option value="draft"${status==='draft'?' selected':''}>Draft</option>
          <option value="in-progress"${status==='in-progress'?' selected':''}>In Progress</option>
          <option value="sent-to-suno"${status==='sent-to-suno'?' selected':''}>Sent to Suno</option>
          <option value="published"${status==='published'?' selected':''}>Published</option>
        </select>
        <span class="hi-date-info">${escHtml(genre)} · ${date}</span>
      </div>
      ${notesPrev}
      <div class="hi-audio-row">
        <input type="text" class="hi-audio-input" placeholder="Suno Audio URL" value="${escHtml(song.audio_url || '')}" onblur="saveHistoryAudioUrl('${song.id}', this.value)" onclick="event.stopPropagation()">
      </div>
      <div class="hi-actions">
        <button class="hi-btn" onclick="reloadSong(${idx})">↩ Load</button>
        <button class="hi-btn" onclick="openVersionHistory('${song.id}')">⏱ Versions</button>
        <button class="hi-btn" onclick="sunoExportSong(${idx})">⚡ Suno</button>
        <button class="hi-btn" onclick="openKaraoke(APP.songs[${idx}].lyrics, APP.songs[${idx}].id)">🎤 Karaoke</button>
        <button class="pub-btn${song.published ? ' on' : ''}" id="pub-${song.id}" data-song-id="${song.id}" data-published="${!!song.published}" onclick="togglePublish(this)">${song.published ? '✓ Published' : '📤 Publish'}</button>
        ${song.published ? `<button class="hi-btn" onclick="shareSong('${song.id}')">🔗 Share</button>` : ''}
        ${APP.plan !== 'free' ? `<button class="hi-btn" onclick="openCowrModal('${song.id}','${escHtml(title)}')">👥 Co-writers</button><button class="hi-btn" onclick="openSuggestModal('${song.id}','${escHtml(title)}',true)">💡 Suggestions</button>` : `<button class="hi-btn locked" onclick="showFeatureUpgrade()">🔒 Co-writers</button><button class="hi-btn locked" onclick="showFeatureUpgrade()">🔒 Suggestions</button>`}
        <button class="hi-btn del" onclick="deleteSong('${song.id}',${idx})">🗑</button>
      </div>`;
    scroll.appendChild(item);
  });

  // Render co-written songs below owned songs
  renderCowriteSongs();
}

function renderCowriteSongs() {
  const scroll = document.getElementById('hpScroll');
  const existing = document.getElementById('cowriteSection');
  if (existing) existing.remove();

  const cwSongs = APP.cowriteSongs || [];
  if (!cwSongs.length) return;

  const section = document.createElement('div');
  section.id = 'cowriteSection';
  section.innerHTML = `<div class="hi-cowrite-section">✍ Co-writing</div>`;

  cwSongs.forEach(song => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const date  = new Date(song.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const title = song.title || song.topic || 'Untitled Song';
    item.innerHTML = `
      <div class="hi-title">${escHtml(title)}<span class="hi-cowrite-badge">Co-writer</span></div>
      <div class="hi-status-row"><span class="hi-date-info">${escHtml(song.genre || 'No genre')} · ${date}</span></div>
      <div class="hi-actions">
        <button class="hi-btn" onclick="openSuggestModal('${song.id}','${escHtml(title)}',false)">💡 Suggest Changes</button>
      </div>`;
    section.appendChild(item);
  });

  scroll.appendChild(section);
}

function reloadSong(idx) {
  const song = APP.songs[idx];
  if (!song) return;

  showView('studio');

  document.getElementById('topic').value = song.topic || '';

  document.querySelectorAll('#genreGrid .pick-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.v === song.genre);
  });
  APP.genre = song.genre || '';

  const moodArr = song.moods ? song.moods.split(',').filter(Boolean) : [];
  document.querySelectorAll('#moodGrid .mood-chip').forEach(b => {
    b.classList.toggle('on', moodArr.includes(b.dataset.v));
  });
  APP.moods = moodArr;

  document.querySelectorAll('#tempoGrid .pick-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.v === song.tempo);
  });
  APP.tempo = song.tempo || 'Mid tempo';

  if (song.structure) {
    const sel = document.getElementById('structure');
    for (const opt of sel.options) { if (opt.value === song.structure) { sel.value = song.structure; break; } }
  }
  if (song.rhyme) {
    const sel = document.getElementById('rhyme');
    for (const opt of sel.options) { if (opt.value === song.rhyme) { sel.value = song.rhyme; break; } }
  }
  if (song.pov) {
    const sel = document.getElementById('pov');
    for (const opt of sel.options) { if (opt.value === song.pov) { sel.value = song.pov; break; } }
  }
  document.getElementById('tone').value = song.style_notes || '';

  const artistStyleInput = document.getElementById('artistStyleInput');
  if (artistStyleInput) artistStyleInput.value = song.artist_style || '';
  APP.artistStyle = song.artist_style || '';

  APP.lyrics = song.lyrics;
  APP.originalLyrics = song.lyrics;
  APP.currentSongId = song.id;

  renderLyrics(song.lyrics);
  if (song.chords) renderChords(song.chords);

  // Show refine panel
  const rp = document.getElementById('refinePanel');
  if (rp) rp.classList.add('on');
  const rrBtn = document.getElementById('refineRevertBtn');
  if (rrBtn) rrBtn.classList.remove('on');

  // Show notes panel with this song's notes and status
  showNotesPanel(song);

  // Show versions button
  const versionsBtn = document.getElementById('versionsBtn');
  if (versionsBtn) versionsBtn.style.display = 'inline-flex';

  toast('Song loaded!');
}

async function deleteSong(id, idx) {
  if (!confirm('Delete this song? This cannot be undone.')) return;
  try {
    await authFetch(`/api/songs?id=${id}`, { method: 'DELETE' });
    APP.songs.splice(idx, 1);
    renderHistory(APP.songs);
    toast('Song deleted.');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function saveSongToHistory(result) {
  if (APP.plan === 'free') return;
  try {
    const topic = APP.advancedMode
      ? document.getElementById('advNarrative').value.trim()
      : document.getElementById('topic').value.trim();
    const sunoPrompt = buildSunoPrompt(result.lyrics, { language: APP.language, mixLanguages: APP.mixLanguages });
    const { song } = await authFetch('/api/songs', {
      method: 'POST',
      body: JSON.stringify({
        title: result.titles?.[0] || null,
        lyrics: result.lyrics,
        genre: APP.advancedMode ? (APP.advGenres.join(', ') || null) : (APP.genre || null),
        moods: APP.moods,
        tempo: APP.tempo || null,
        structure: APP.advancedMode
          ? document.getElementById('advStructure').value
          : document.getElementById('structure').value,
        rhyme: activeVal('rhyme', 'advRhyme') || null,
        pov: activeVal('pov', 'advPov') || null,
        topic: topic || null,
        style_notes: activeVal('tone', 'advTone') || null,
        chords: result.chords || null,
        suno_prompt: sunoPrompt,
        artist_style: APP.artistStyle || null
      })
    });
    APP.currentSongId = song.id;
    KAR.songId = song.id;

    // Show notes panel (blank for new song) and versions button
    showNotesPanel({ notes: '', status: 'draft' });
    const versionsBtn = document.getElementById('versionsBtn');
    if (versionsBtn) versionsBtn.style.display = 'inline-flex';
  } catch (e) {
    console.warn('[saveSongToHistory]', e.message);
  }
}

// ── UPLOAD LYRICS ──
function openUploadLyrics() {
  if (APP.plan === 'free') {
    document.getElementById('featureUpgradeBg').classList.add('on');
    return;
  }
  // Reset modal state
  document.getElementById('ulLyrics').value = '';
  document.getElementById('ulTitle').value = '';
  document.getElementById('ulGenre').value = '';
  document.getElementById('ulProcessing').classList.remove('on');
  ['ulRewriteBtn','ulCompleteBtn','ulSaveBtn','ulCancelBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  document.getElementById('uploadLyricsBg').classList.add('on');
}

async function submitUploadedLyrics(action) {
  const lyrics = document.getElementById('ulLyrics').value.trim();
  const title = document.getElementById('ulTitle').value.trim();
  const genre = document.getElementById('ulGenre').value;

  if (!lyrics) { toast('Please paste your lyrics first.'); return; }

  if (action === 'save') {
    closeModal('uploadLyricsBg');
    APP.lyrics = lyrics;
    APP.originalLyrics = lyrics;
    APP.currentSongId = null;
    if (genre) APP.genre = genre;
    renderLyrics(lyrics);
    if (title) document.getElementById('rpLabel').textContent = title;
    await _saveUploadedToHistory({ lyrics, title, genre });
    return;
  }

  // Disable buttons and show spinner
  ['ulRewriteBtn','ulCompleteBtn','ulSaveBtn','ulCancelBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  const procMsg = document.getElementById('ulProcessingMsg');
  procMsg.textContent = action === 'rewrite' ? 'Rewriting your lyrics...' : 'Completing your song...';
  document.getElementById('ulProcessing').classList.add('on');

  try {
    const result = await authFetch('/api/refine', {
      method: 'POST',
      body: JSON.stringify({
        lyrics,
        instructions: action === 'rewrite' ? '__upload_rewrite__' : '__upload_complete__',
        genre: genre || '',
        action: 'upload_' + action
      })
    });

    closeModal('uploadLyricsBg');
    APP.lyrics = result.lyrics;
    APP.originalLyrics = result.lyrics;
    APP.currentSongId = null;
    if (genre) APP.genre = genre;
    if (result.usage !== undefined) { APP.usage = result.usage; APP.limit = result.limit; updateUsage(); }

    renderLyrics(result.lyrics);
    if (title) document.getElementById('rpLabel').textContent = title;
    await _saveUploadedToHistory({ lyrics: result.lyrics, title, genre });

  } catch (e) {
    toast('Error: ' + e.message);
    ['ulRewriteBtn','ulCompleteBtn','ulSaveBtn','ulCancelBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });
    document.getElementById('ulProcessing').classList.remove('on');
  }
}

async function _saveUploadedToHistory({ lyrics, title, genre }) {
  if (APP.plan === 'free') return;
  try {
    const sunoPrompt = buildSunoPrompt(lyrics, { genre: genre || '', language: APP.language, mixLanguages: APP.mixLanguages, moods: [], tempo: '' });
    const { song } = await authFetch('/api/songs', {
      method: 'POST',
      body: JSON.stringify({
        title: title || null,
        lyrics,
        genre: genre || null,
        moods: [],
        tempo: null,
        structure: null,
        rhyme: null,
        pov: null,
        topic: title || null,
        style_notes: null,
        chords: null,
        suno_prompt: sunoPrompt,
        artist_style: null
      })
    });
    APP.currentSongId = song.id;
    KAR.songId = song.id;
    showNotesPanel({ notes: '', status: 'draft' });
    const versionsBtn = document.getElementById('versionsBtn');
    if (versionsBtn) versionsBtn.style.display = 'inline-flex';
  } catch (e) {
    console.warn('[_saveUploadedToHistory]', e.message);
  }
}

// ── QUICK REFINE ──
function openQuickRefine() {
  if (!APP.lyrics) { toast('Generate a song first.'); return; }
  if (APP.plan === 'free') { document.getElementById('featureUpgradeBg').classList.add('on'); return; }

  // Reset state
  ['qrMoodToggle','qrGenreToggle','qrChordsToggle','qrVerseToggle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  ['qrMoodSub','qrGenreSub','qrVerseSub'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.querySelectorAll('#qrMoodChips .mood-chip').forEach(b => b.classList.remove('on'));
  const qrGenre = document.getElementById('qrGenreSelect');
  if (qrGenre) qrGenre.value = '';
  const qrCustom = document.getElementById('qrCustom');
  if (qrCustom) qrCustom.value = '';
  const qrApply = document.getElementById('qrApplyBtn');
  if (qrApply) qrApply.disabled = false;

  // Populate verse dropdown from current lyrics
  const verseSelect = document.getElementById('qrVerseSelect');
  if (verseSelect) {
    const sections = getLyricsSections(APP.lyrics);
    verseSelect.innerHTML = sections.length
      ? sections.map(s => `<option value="${s}">${s}</option>`).join('')
      : '<option value="">No sections found</option>';
  }

  const panel = document.getElementById('quickRefinePanel');
  if (panel) {
    panel.classList.add('on');
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  }
}

function closeQuickRefine() {
  const panel = document.getElementById('quickRefinePanel');
  if (panel) panel.classList.remove('on');
}

function toggleQrSection(name, on) {
  const subMap = { mood: 'qrMoodSub', genre: 'qrGenreSub', verse: 'qrVerseSub' };
  const el = document.getElementById(subMap[name]);
  if (el) el.style.display = on ? '' : 'none';
}

function getLyricsSections(lyrics) {
  if (!lyrics) return [];
  const seen = new Set();
  return lyrics.split('\n')
    .map(l => l.trim())
    .filter(l => /^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(l))
    .filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
}

function buildQuickRefineInstructions() {
  const parts = [];

  const moodOn = document.getElementById('qrMoodToggle')?.checked;
  if (moodOn) {
    const moods = [...document.querySelectorAll('#qrMoodChips .mood-chip.on')].map(b => b.dataset.v);
    if (moods.length) parts.push(`Change the emotional tone and mood to: ${moods.join(', ')}. Adjust word choice, imagery, and feeling throughout to match.`);
    else parts.push('Refine the emotional tone — make it more emotionally resonant throughout.');
  }

  const genreOn = document.getElementById('qrGenreToggle')?.checked;
  if (genreOn) {
    const g = document.getElementById('qrGenreSelect')?.value;
    if (g) parts.push(`Shift the lyrical style and vocabulary toward ${g} — adapt the phrasing, rhythm, and references to fit that genre.`);
  }

  const chordsOn = document.getElementById('qrChordsToggle')?.checked;

  const verseOn = document.getElementById('qrVerseToggle')?.checked;
  if (verseOn) {
    const section = document.getElementById('qrVerseSelect')?.value;
    if (section) parts.push(`IMPORTANT: Only rewrite the ${section} section. Leave every other section word-for-word exactly as written. Do not alter anything outside of ${section}.`);
  }

  const custom = document.getElementById('qrCustom')?.value.trim();
  if (custom) parts.push(custom);

  return { instructions: parts.join(' ') || 'Polish and improve the lyrics overall.', refineChords: chordsOn };
}

async function submitQuickRefine() {
  if (!APP.lyrics) return;
  const { instructions, refineChords } = buildQuickRefineInstructions();
  gaEvent('tweak_refine_used', { mode: 'quick' });
  const qrApply = document.getElementById('qrApplyBtn');
  if (qrApply) qrApply.disabled = true;

  try {
    const result = await authFetch('/api/refine', {
      method: 'POST',
      body: JSON.stringify({
        lyrics: APP.lyrics,
        instructions,
        genre: APP.advancedMode ? (APP.advGenres[0] || '') : (APP.genre || ''),
        moods: APP.moods,
        tempo: APP.tempo || '',
        songId: APP.currentSongId || null,
        refineChords
      })
    });

    closeQuickRefine();
    APP.originalLyrics = APP.lyrics;
    APP.lyrics = result.lyrics;
    renderLyrics(result.lyrics);
    if (result.chords) renderChords(result.chords);
    if (result.usage !== undefined) { APP.usage = result.usage; APP.limit = result.limit; updateUsage(); }

    // Update saved song if one is loaded
    if (APP.currentSongId) {
      authFetch('/api/songs', {
        method: 'PATCH',
        body: JSON.stringify({ id: APP.currentSongId, lyrics: result.lyrics })
      }).catch(() => {});
    }

    const rrBtn = document.getElementById('refineRevertBtn');
    if (rrBtn) rrBtn.classList.add('on');
    toast('Changes applied.');
  } catch (e) {
    toast('Error: ' + e.message);
    if (qrApply) qrApply.disabled = false;
  }
}

// Wire up qrMoodChips click handlers (called once on init)
function initQuickRefine() {
  document.querySelectorAll('#qrMoodChips .mood-chip').forEach(b => {
    b.addEventListener('click', () => b.classList.toggle('on'));
  });
}

// ── SUNO EXPORT ──
// ── SUNO GENRE STYLE MAP ──
const SUNO_GENRE_MAP = {
  'Country':              { v: 'country vocals',                         i: 'acoustic guitar, fiddle, steel guitar, banjo' },
  'Rap / Hip Hop':        { v: 'rap vocals, hip hop flow',               i: 'hip hop beat, 808 bass, trap hi-hats' },
  'Hip Hop':              { v: 'hip hop vocals',                         i: 'hip hop beat, 808 bass, sampled drums' },
  'Pop':                  { v: 'pop vocals',                             i: 'synth, clean production, programmed drums' },
  'Rock':                 { v: 'rock vocals',                            i: 'electric guitar, bass guitar, live drums' },
  'R&B':                  { v: 'R&B vocals, soulful',                    i: 'smooth production, warm keys, sub bass' },
  'Blues':                { v: 'blues vocals, raw',                      i: 'blues guitar, harmonica, shuffle drums' },
  'Folk':                 { v: 'folk vocals, intimate',                  i: 'acoustic guitar, fingerpicking, soft brush drums' },
  'Military / Patriotic': { v: 'powerful anthemic vocals',               i: 'orchestral brass, snare drum, strings' },
  'Gospel':               { v: 'gospel vocals, choir harmony',           i: 'organ, piano, full choir' },
  'Americana':            { v: 'americana vocals, rootsy',               i: 'acoustic guitar, mandolin, upright bass' },
  'Outlaw Country':       { v: 'outlaw country vocals, gritty twang',    i: 'electric guitar, honky tonk piano, shuffle drums' },
  'Trap':                 { v: 'trap rap vocals, ad-libs',               i: 'trap beat, rolling hi-hats, 808 bass, dark synth' },
  'Singer-Songwriter':    { v: 'singer-songwriter vocals, confessional', i: 'acoustic guitar, light piano, minimal production' },
  'Metal':                { v: 'metal vocals, powerful',                 i: 'heavy distorted guitar, double kick drums, thick bass' },
  'Alternative':          { v: 'alternative rock vocals',                i: 'layered guitar, indie production, driving drums' },
  'EDM':                  { v: 'electronic vocals, vocal chops',         i: 'synth lead, bass drop, dance beat, sub bass' },
  'Latin':                { v: 'latin vocals, passionate',               i: 'latin percussion, guitar, brass, congas' },
};

function buildGenreStyleTags(genreList) {
  if (!genreList || genreList.length === 0) return '';
  const isRap = genreList.some(g => /rap|hip.?hop|trap/i.test(g));
  if (genreList.length === 1) {
    const s = SUNO_GENRE_MAP[genreList[0]];
    return s ? `${s.v}, ${s.i}` : genreList[0];
  }
  // Multi-genre blend: combine vocals, take top 2 instruments per genre
  const vocals = genreList.map(g => SUNO_GENRE_MAP[g]?.v || g).join(', ');
  const instruments = [...new Set(
    genreList.flatMap(g => (SUNO_GENRE_MAP[g]?.i || '').split(', ').slice(0, 2))
  )].join(', ');
  let style = `${vocals}, ${instruments}`;
  if (isRap) {
    const nonRap = genreList.filter(g => !/rap|hip.?hop|trap/i.test(g));
    if (nonRap.length) style += `, rap verses, sung ${nonRap[0].toLowerCase()} hook`;
  }
  return style;
}

function buildSunoPrompt(lyrics, opts = {}) {
  // Resolve genre list — advanced mode passes genres array; simple mode uses APP.genre
  const genreList = opts.genres && opts.genres.length
    ? opts.genres
    : APP.advancedMode
      ? (APP.advGenres.length ? APP.advGenres : [])
      : (opts.genre !== undefined ? (opts.genre ? [opts.genre] : []) : (APP.genre ? [APP.genre] : []));

  const moods = opts.moods !== undefined ? opts.moods : APP.moods;
  const tempo = opts.tempo !== undefined ? opts.tempo : APP.tempo || '';
  const styleNotes = opts.styleNotes !== undefined ? opts.styleNotes : (document.getElementById('tone')?.value || '');
  const language = opts.language !== undefined ? opts.language : APP.language || 'English';
  const mixLanguages = opts.mixLanguages !== undefined ? opts.mixLanguages : APP.mixLanguages;

  const genreStyle = buildGenreStyleTags(genreList);
  const moodsStr = Array.isArray(moods) ? moods.join(', ') : (moods || '');
  let langTag = '';
  if (mixLanguages) { langTag = 'multilingual vocals'; }
  else if (language && language !== 'English') { langTag = `${language} vocals`; }

  const styleParts = [genreStyle || genreList.join(' + '), moodsStr, tempo, styleNotes, langTag].filter(Boolean);
  let out = styleParts.length ? `Style: ${styleParts.join(', ')}\n\n` : '';

  const formatted = lyrics.split('\n').map(line => {
    const t = line.trim();
    if (/^(VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(t)) {
      return `[${t}]`;
    }
    return line;
  }).join('\n');

  return out + formatted;
}

function exportToSuno() {
  if (!APP.lyrics) { toast('Generate a song first.'); return; }
  const prompt = buildSunoPrompt(APP.lyrics);
  document.getElementById('sunoText').textContent = prompt;
  document.getElementById('sunoPanel').classList.add('on');
  setTimeout(() => document.getElementById('sunoPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

function closeSunoPanel() {
  document.getElementById('sunoPanel').classList.remove('on');
}

function copySuno() {
  const text = document.getElementById('sunoText').textContent;
  navigator.clipboard.writeText(text);
  gaEvent('export_to_suno', { source: 'studio' });
  window.open('https://suno.com', '_blank');
  toast('Lyrics copied — Suno is opening!');
}

// ── SHARE ──
function shareSong(id) {
  const url = `${window.location.origin}/song/${id}`;
  navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard!'))
    .catch(() => { prompt('Copy this link:', url); });
}

// ── CO-WRITER ──
let _cwSongId = null;

function bgCloseCw(e, id) { if (e.target.id === id) closeCwModal(id); }
function closeCwModal(id) { document.getElementById(id).classList.remove('on'); }

async function openCowrModal(songId, songTitle) {
  _cwSongId = songId;
  document.getElementById('cowrSongTitle').textContent = songTitle;
  document.getElementById('cowrEmailInput').value = '';
  document.getElementById('cowrOverlay').classList.add('on');
  await refreshCowrList();
}

async function refreshCowrList() {
  const list = document.getElementById('cowrList');
  list.innerHTML = '<div class="cw-empty">Loading…</div>';
  try {
    const { cowriters } = await authFetch(`/api/cowrite?song_id=${_cwSongId}`);
    if (!cowriters.length) {
      list.innerHTML = '<div class="cw-empty">No co-writers yet. Invite someone by email.</div>';
      return;
    }
    list.innerHTML = cowriters.map(cw => `
      <div class="cw-item" id="cwitem-${cw.id}">
        <span class="cw-item-email">${escHtml(cw.invitee_email)}</span>
        <span class="cw-item-status ${cw.status}">${cw.status}</span>
        <button class="cw-item-remove" title="Remove" onclick="removeCowriter('${cw.id}')">✕</button>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="cw-empty" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function inviteCowriter() {
  const email = document.getElementById('cowrEmailInput').value.trim();
  if (!email) { toast('Enter an email address.'); return; }
  const btn = document.getElementById('cowrInviteBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await authFetch('/api/cowrite', {
      method: 'POST',
      body: JSON.stringify({ song_id: _cwSongId, email })
    });
    document.getElementById('cowrEmailInput').value = '';
    toast(`Invited ${email}!`);
    await refreshCowrList();
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Invite';
  }
}

async function removeCowriter(id) {
  try {
    await authFetch(`/api/cowrite?id=${id}`, { method: 'DELETE' });
    document.getElementById(`cwitem-${id}`)?.remove();
    const list = document.getElementById('cowrList');
    if (!list.children.length) list.innerHTML = '<div class="cw-empty">No co-writers yet.</div>';
  } catch (e) { toast('Error: ' + e.message); }
}

// ── SUGGESTIONS ──
let _sgSongId = null;
let _sgIsOwner = false;

async function openSuggestModal(songId, songTitle, isOwner) {
  _sgSongId = songId;
  _sgIsOwner = isOwner;
  document.getElementById('sgSongTitle').textContent = songTitle;
  document.getElementById('sgModalTitle').textContent = isOwner ? '💡 Review Suggestions' : '💡 Suggest Changes';
  document.getElementById('sgOverlay').classList.add('on');
  await refreshSuggestions();
}

async function refreshSuggestions() {
  const body = document.getElementById('sgBody');
  body.innerHTML = '<div class="cw-empty">Loading…</div>';
  try {
    const { suggestions } = await authFetch(`/api/suggestions?song_id=${_sgSongId}`);

    if (_sgIsOwner) {
      // Owner sees all suggestions to review
      const pending = suggestions.filter(s => s.status === 'pending');
      const resolved = suggestions.filter(s => s.status !== 'pending');
      let html = '';
      if (!suggestions.length) {
        html = '<div class="cw-empty">No suggestions yet.</div>';
      } else {
        if (pending.length) {
          html += `<div class="cw-section-label" style="margin-bottom:10px">Pending (${pending.length})</div>`;
          html += pending.map(s => `
            <div class="sg-card" id="sgcard-${s.id}">
              <div class="sg-card-meta">From ${escHtml(s.author_name || 'Co-writer')} · ${new Date(s.created_at).toLocaleDateString()}</div>
              ${s.comment ? `<div class="sg-card-comment">"${escHtml(s.comment)}"</div>` : ''}
              <div class="sg-card-text">${escHtml(s.suggested_text)}</div>
              <div class="sg-card-actions">
                <button class="sg-accept" onclick="reviewSuggestion('${s.id}','accepted')">✓ Accept &amp; Apply</button>
                <button class="sg-reject" onclick="reviewSuggestion('${s.id}','rejected')">✗ Reject</button>
              </div>
            </div>`).join('');
        }
        if (resolved.length) {
          html += `<div class="cw-section-label" style="margin:14px 0 10px">Resolved</div>`;
          html += resolved.map(s => `
            <div class="sg-card">
              <div class="sg-card-meta">${escHtml(s.author_name || 'Co-writer')} · ${new Date(s.created_at).toLocaleDateString()} <span class="sg-status-badge ${s.status}">${s.status}</span></div>
              <div class="sg-card-text">${escHtml(s.suggested_text.substring(0, 120))}${s.suggested_text.length > 120 ? '…' : ''}</div>
            </div>`).join('');
        }
      }
      body.innerHTML = html;
    } else {
      // Co-writer sees their own suggestions + submit form
      const mine = suggestions.filter(s => s.author_id === APP.user?.id);
      let html = '';
      if (mine.length) {
        html += `<div class="cw-section-label" style="margin-bottom:10px">Your previous suggestions</div>`;
        html += mine.map(s => `
          <div class="sg-card">
            <div class="sg-card-meta">${new Date(s.created_at).toLocaleDateString()} <span class="sg-status-badge ${s.status}">${s.status}</span></div>
            ${s.comment ? `<div class="sg-card-comment">"${escHtml(s.comment)}"</div>` : ''}
            <div class="sg-card-text">${escHtml(s.suggested_text.substring(0, 120))}${s.suggested_text.length > 120 ? '…' : ''}</div>
          </div>`).join('');
        html += '<div style="margin-bottom:16px"></div>';
      }
      html += `<div class="cw-section-label" style="margin-bottom:10px">Submit new suggestion</div>
        <textarea class="sg-textarea" id="sgText" placeholder="Paste your suggested lyrics here…"></textarea>
        <input class="sg-comment" id="sgComment" placeholder="Optional note to the owner…" type="text">
        <button class="sg-submit" onclick="submitSuggestion()">Submit Suggestion</button>`;
      body.innerHTML = html;
    }
  } catch (e) {
    body.innerHTML = `<div class="cw-empty" style="color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function submitSuggestion() {
  const text = document.getElementById('sgText')?.value?.trim();
  const comment = document.getElementById('sgComment')?.value?.trim();
  if (!text) { toast('Enter your suggested lyrics.'); return; }
  const btn = document.querySelector('.sg-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    await authFetch('/api/suggestions', {
      method: 'POST',
      body: JSON.stringify({ song_id: _sgSongId, suggested_text: text, comment })
    });
    toast('Suggestion submitted!');
    await refreshSuggestions();
  } catch (e) {
    toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Suggestion'; }
  }
}

async function reviewSuggestion(id, status) {
  const card = document.getElementById(`sgcard-${id}`);
  try {
    const result = await authFetch('/api/suggestions', {
      method: 'PATCH',
      body: JSON.stringify({ id, status })
    });
    if (status === 'accepted' && result.lyricsUpdated) {
      // Update in-memory cache for this song
      const idx = APP.songs.findIndex(s => s.id === _sgSongId);
      if (idx >= 0) {
        const { suggestions } = await authFetch(`/api/suggestions?song_id=${_sgSongId}`);
        const sg = suggestions.find(s => s.id === id);
        if (sg) APP.songs[idx].lyrics = sg.suggested_text;
      }
      toast('Suggestion accepted — lyrics updated!');
    } else {
      toast('Suggestion rejected.');
    }
    if (card) card.remove();
    await refreshSuggestions();
  } catch (e) { toast('Error: ' + e.message); }
}

// ── TIKTOK HOOKS ──
async function openHooksPanel() {
  if (!APP.lyrics) { toast('Generate a song first.'); return; }
  const panel = document.getElementById('hooksPanel');
  const body  = document.getElementById('hooksBody');
  panel.classList.add('on');
  body.innerHTML = '<div class="hooks-loading"><span class="spinner"></span> Generating hooks…</div>';
  // Scroll panel into view
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    // authFetch throws on non-ok and returns the parsed JSON object directly
    const data = await authFetch('/api/rhyme?action=hooks', {
      method: 'POST',
      body: JSON.stringify({
        lyrics: APP.lyrics,
        genre:  APP.genre  || '',
        moods:  APP.moods  || [],
        topic:  document.getElementById('topic')?.value?.trim() || ''
      })
    });

    body.innerHTML = data.hooks.map((hook, i) => `
      <div class="hook-card">
        <div class="hook-num">Hook ${i + 1}</div>
        <div class="hook-text">${escHtml(hook)}</div>
        <button class="hook-copy" onclick="copyHook(this, ${i})">Copy</button>
      </div>`).join('');
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

function closeHooksPanel() {
  document.getElementById('hooksPanel').classList.remove('on');
}

function copyHook(btn, idx) {
  const cards = document.querySelectorAll('.hook-text');
  if (!cards[idx]) return;
  navigator.clipboard.writeText(cards[idx].textContent.trim());
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
}

function sunoExportSong(idx) {
  const song = APP.songs[idx];
  if (!song) return;
  const prompt = buildSunoPrompt(song.lyrics, {
    genre: song.genre || '',
    moods: song.moods ? song.moods.split(',').filter(Boolean) : [],
    tempo: song.tempo || '',
    styleNotes: song.style_notes || ''
  });
  navigator.clipboard.writeText(prompt);
  gaEvent('export_to_suno', { source: 'history' });
  window.open('https://suno.com', '_blank');
  toast('Lyrics copied — Suno is opening!');
}

// ── AUTO SYNC ──
function buildSegmentsFromWords(words) {
  if (!words?.length) return [];
  const segs = [];
  const chunk = 7;
  for (let i = 0; i < words.length; i += chunk) {
    const w = words.slice(i, i + chunk);
    segs.push({ text: w.map(x => x.word).join(' '), start: w[0].start, end: w[w.length - 1].end });
  }
  return segs;
}

function matchLyricsToTimestamps(lines, segments, words) {
  const lineTs = lines.map(() => null);
  const wordTs = lines.map(() => null);  // per-line array of per-word start times
  const lyricLines = lines.map((l, i) => ({ ...l, i })).filter(l => !l.isLabel);
  if (!lyricLines.length) return { lineTs, wordTs };

  const normWord = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // ── Word-level matching (preferred) ──────────────────────────────────────
  const wds = (words || [])
    .map(w => ({ ...w, n: normWord(w.word) }))
    .filter(w => w.n.length > 0);

  console.log('[kar] Whisper words received:', wds.length, wds.map(w => `"${w.word}"@${w.start.toFixed(2)}`));

  // Regex that identifies a line that IS a section label (entire line = label)
  const LABEL_LINE_RE = /^\s*\[?(?:VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)[^\]]*\]?\s*$/i;
  // Regex that strips a section-label prefix from the start of a line
  const LABEL_PREFIX_RE = /^\s*\[?(?:VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)[^\]]*\]?\s*/i;

  if (wds.length > 0) {
    let wPtr = 0;
    lyricLines.forEach(line => {
      // Skip lines that are purely section labels — Whisper won't transcribe them,
      // so attempting to match wastes the search budget and can collide with real lyrics.
      if (LABEL_LINE_RE.test(line.text)) {
        console.log(`[kar] line ${line.i} "${line.text}" → SKIPPED (section label)`);
        return;
      }

      const lw = line.text
        .replace(LABEL_PREFIX_RE, '')
        .toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);

      // Nothing left after stripping — treat as a label and skip without touching wPtr
      if (!lw.length) return;

      // Search from wPtr to the end of the word array — no fixed cap.
      // A hard window size caused the second half of longer songs to fall off
      // the edge when wPtr lagged behind due to unmatched lines.
      const searchLimit = wds.length;

      let bestScore = 0.10;   // lowered from 0.15 — near-matches now accepted
      let bestPos   = -1;

      for (let s = wPtr; s < searchLimit; s++) {
        const winEnd = Math.min(wds.length, s + lw.length + 3);
        const win    = wds.slice(s, winEnd);
        const winSet = new Set(win.map(w => w.n));
        const hits   = lw.filter(w => winSet.has(w)).length;
        const score  = hits / Math.max(lw.length, win.length);
        if (score > bestScore) { bestScore = score; bestPos = s; }
      }

      if (bestPos >= 0) {
        lineTs[line.i] = wds[bestPos].start;

        // ── Per-word timestamps ──────────────────────────────────────────
        const win = wds.slice(bestPos, Math.min(wds.length, bestPos + lw.length + 5));
        const wtArr = new Array(lw.length).fill(null);
        let winPtr = 0;
        for (let k = 0; k < lw.length; k++) {
          for (let m = winPtr; m < win.length; m++) {
            if (win[m].n === lw[k]) { wtArr[k] = win[m].start; winPtr = m + 1; break; }
          }
        }
        // Interpolate unmatched words
        for (let k = 0; k < wtArr.length; k++) {
          if (wtArr[k] !== null) continue;
          const prev = wtArr.slice(0, k).reverse().find(t => t !== null);
          const next = wtArr.slice(k + 1).find(t => t !== null);
          if (prev != null && next != null)      wtArr[k] = (prev + next) / 2;
          else if (prev != null)                 wtArr[k] = prev + 0.2;
          else if (next != null)                 wtArr[k] = Math.max(lineTs[line.i], next - 0.2);
          else                                   wtArr[k] = lineTs[line.i];
        }
        wordTs[line.i] = wtArr;

        console.log(`[kar] line ${line.i} "${line.text.substring(0,40)}" → lineTs=${lineTs[line.i].toFixed(2)} bestPos=${bestPos} score=${bestScore.toFixed(2)} wordTs=[${wtArr.map(x=>x!=null?x.toFixed(2):'null').join(', ')}]`);

        // Clamp so wPtr never exceeds the last valid index.
        // bestPos near the end + lw.length could otherwise push wPtr past
        // wds.length, making the for-loop condition (s < wds.length) always
        // false and cascading every remaining line to NO MATCH.
        wPtr = Math.min(bestPos + Math.max(1, lw.length - 1), wds.length - 1);
      } else {
        // wPtr stays unchanged on no-match — do not advance.
        // Advancing on no-match was pushing wPtr past the end of the array,
        // causing every subsequent line to also fail.
        console.log(`[kar] line ${line.i} "${line.text.substring(0,40)}" → NO MATCH (wPtr=${wPtr}, searchLimit=${searchLimit})`);
      }
    });
  } else {
    // ── Segment-level fallback (no word timestamps available) ────────────
    const segs = segments?.length ? segments : buildSegmentsFromWords(words);
    if (!segs?.length) return { lineTs, wordTs };

    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const similarity = (a, b) => {
      const wa = norm(a), wb = new Set(norm(b));
      if (!wa.length || !wb.size) return 0;
      return wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size);
    };

    let segPtr = 0;
    lyricLines.forEach(line => {
      let bestScore = 0.08, bestIdx = -1;
      const end = Math.min(segs.length, segPtr + 10);
      for (let j = segPtr; j < end; j++) {
        const score = similarity(line.text, segs[j].text);
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }
      if (bestIdx >= 0) { lineTs[line.i] = segs[bestIdx].start; segPtr = bestIdx + 1; }
    });
  }

  // ── Trailing interpolation ───────────────────────────────────────────────
  // Lines after the last successful match get evenly distributed timestamps
  // between the last matched time and the song's total duration (from the
  // last Whisper word's end time).  This handles repeated sections where
  // Whisper's word array runs out before all lyric lines are matched.
  const songDuration = wds.length > 0
    ? (wds[wds.length - 1].end ?? (wds[wds.length - 1].start + 0.5))
    : 0;

  const lastMatchIdx = lineTs.reduce((best, t, i) => t !== null ? i : best, -1);
  if (lastMatchIdx >= 0 && songDuration > 0) {
    const lastMatchTs = lineTs[lastMatchIdx];
    const trailing = [];
    for (let i = lastMatchIdx + 1; i < lineTs.length; i++) {
      if (lineTs[i] === null && !lines[i].isLabel) trailing.push(i);
    }
    if (trailing.length > 0 && songDuration > lastMatchTs) {
      const step = (songDuration - lastMatchTs) / (trailing.length + 1);
      trailing.forEach((idx, k) => { lineTs[idx] = lastMatchTs + step * (k + 1); });
    }
  }

  // ── Interior / leading gap interpolation ─────────────────────────────────
  // Fill any remaining nulls (gaps between two known timestamps, or leading
  // lines before the first match).
  for (let i = 0; i < lineTs.length; i++) {
    if (lineTs[i] !== null || lines[i].isLabel) continue;
    const prev = lineTs.slice(0, i).reverse().find(t => t !== null);
    const next = lineTs.slice(i + 1).find(t => t !== null);
    if (prev != null && next != null) lineTs[i] = (prev + next) / 2;
    else if (prev != null)            lineTs[i] = prev + 2;
    else if (next != null)            lineTs[i] = Math.max(0, next - 2);
  }

  console.log('[kar] final lineTs:', lineTs.map((t,i) => `[${i}]${t!=null?t.toFixed(2):'null'}`).join(' '));
  return { lineTs, wordTs };
}

async function autoSync() {
  if (!KAR.audioUrl && !KAR.audioFile) { toast('Load audio first.'); return; }

  const btn = document.getElementById('karAutoSyncBtn');
  btn.textContent = '⏳ Transcribing...';
  btn.disabled = true;

  try {
    let result;

    if (KAR.audioUrl) {
      // Send URL — server downloads and sends to Whisper
      result = await authFetch('/api/transcribe', {
        method: 'POST',
        body: JSON.stringify({ url: KAR.audioUrl })
      });
    } else {
      // Send file as raw binary
      if (KAR.audioFile.size > 24 * 1024 * 1024) {
        toast('File too large for Auto Sync (max 24 MB).');
        return;
      }
      const token = await getToken();
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': KAR.audioFile.type || 'audio/mpeg',
          'X-Filename': KAR.audioFile.name
        },
        body: KAR.audioFile
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Transcription failed');
      }
      result = await res.json();
    }

    const { segments, words } = result;
    if (!segments?.length && !words?.length) {
      toast('No speech detected in audio. Try manual sync.');
      return;
    }

    const { lineTs, wordTs } = matchLyricsToTimestamps(KAR.lines, segments, words);
    const matchCount = lineTs.filter(t => t !== null).length;

    if (!matchCount) {
      toast('Could not match lyrics to audio. Try manual sync.');
      return;
    }

    // Apply line + word timestamps
    KAR.lines.forEach((line, i) => { line.timestamp = lineTs[i]; line.wordTs = wordTs[i] ?? null; });

    // Save v2 sync data to Supabase
    const syncPayload = JSON.stringify({ v: 2, lines: lineTs, words: wordTs });
    if (KAR.songId) {
      await authFetch('/api/songs', {
        method: 'PATCH',
        body: JSON.stringify({ id: KAR.songId, sync_data: syncPayload })
      });
      const idx = APP.songs.findIndex(s => s.id === KAR.songId);
      if (idx >= 0) APP.songs[idx].sync_data = syncPayload;
    }

    // Switch to play mode
    KAR.mode = 'play';
    KAR.currentLine = -1;
    document.getElementById('karModeSyncBtn').classList.remove('active');
    document.getElementById('karModePlayBtn').classList.add('active');
    document.getElementById('karHint').textContent = 'Lines highlight automatically during playback';
    document.getElementById('karSaveBtn').style.display = 'block';
    renderKarLines();

    const lyricCount = KAR.lines.filter(l => !l.isLabel).length;
    toast(`✨ Auto sync complete — ${matchCount} / ${lyricCount} lines matched`);

  } catch (e) {
    toast('Auto sync failed: ' + e.message);
  } finally {
    btn.textContent = '✨ Auto Sync';
    btn.disabled = false;
  }
}

// ── KARAOKE ──
// Studio Karaoke button — works from the right panel for all plans
function studioKaraoke() {
  if (APP.plan === 'free') { showFeatureUpgrade(); return; }
  if (!APP.lyrics) { toast('Generate a song first.'); return; }
  openKaraoke(APP.lyrics, APP.currentSongId);
}

function openKaraoke(lyrics, songId) {
  if (APP.plan === 'free') { showFeatureUpgrade(); return; }

  gaEvent('karaoke_mode_used');

  KAR.lines     = [];
  KAR.audioUrl  = '';
  KAR.audioFile = null;
  lyrics.split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    const isLabel = /^\[?(?:VERSE|CHORUS|BRIDGE|PRE-CHORUS|INTRO|OUTRO|HOOK|BREAK|TAG|REFRAIN)/i.test(t);
    KAR.lines.push({ text: t, isLabel, timestamp: null });
  });

  KAR.songId = songId || APP.currentSongId || null;

  // Restore saved sync data if available
  const cachedSong = KAR.songId ? APP.songs.find(s => s.id === KAR.songId) : null;
  let hasSavedSync = false;
  if (cachedSong?.sync_data) {
    try {
      const saved = JSON.parse(cachedSong.sync_data);
      if (Array.isArray(saved)) {
        // v1 format: plain array of line timestamps
        KAR.lines.forEach((line, i) => { line.timestamp = saved[i] ?? null; line.wordTs = null; });
      } else if (saved?.v === 2) {
        // v2 format: {v:2, lines:[...], words:[[t,t,...]|null,...]}
        KAR.lines.forEach((line, i) => {
          line.timestamp = saved.lines?.[i] ?? null;
          line.wordTs    = saved.words?.[i] ?? null;
        });
      }
      hasSavedSync = KAR.lines.some(l => l.timestamp !== null);
    } catch { /* ignore corrupt data */ }
  }

  // Default to play mode if sync data exists, sync mode otherwise
  KAR.mode = hasSavedSync ? 'play' : 'sync';
  KAR.currentLine = -1;

  renderKarLines();

  document.getElementById('karModeSyncBtn').classList.toggle('active', KAR.mode === 'sync');
  document.getElementById('karModePlayBtn').classList.toggle('active', KAR.mode === 'play');
  document.getElementById('karPlayBtn').textContent = '▶ Play';
  document.getElementById('karTime').textContent = '0:00';
  document.getElementById('karSaveBtn').style.display = hasSavedSync ? 'block' : 'none';
  document.getElementById('karHint').textContent = KAR.mode === 'play'
    ? 'Lines highlight automatically during playback'
    : 'Tap lines while playing to set timestamps';
  document.getElementById('karAutoSyncBtn').style.display = 'none';

  const audio = document.getElementById('karAudio');
  audio.pause();
  audio.src = '';

  // Pre-populate audio URL from saved value
  const karUrlInput = document.getElementById('karAudioUrl');
  if (karUrlInput) {
    let savedUrl = '';
    const studioInput = document.getElementById('studioAudioUrl');
    if (studioInput && KAR.songId === APP.currentSongId) savedUrl = studioInput.value.trim();
    if (!savedUrl && cachedSong) savedUrl = cachedSong.audio_url || '';
    karUrlInput.value = savedUrl;
    if (savedUrl) {
      KAR.audioUrl = savedUrl;
      audio.src = savedUrl;
      audio.load();
      document.getElementById('karAutoSyncBtn').style.display = 'inline-block';
    }
  }

  document.getElementById('karOverlay').classList.add('on');
}

function closeKaraoke() {
  document.getElementById('karOverlay').classList.remove('on');
  document.getElementById('karAudio').pause();
  document.getElementById('karPlayBtn').textContent = '▶ Play';
}

function renderKarLines() {
  const container = document.getElementById('karLines');
  container.innerHTML = '';
  KAR.lines.forEach((line, idx) => {
    const div = document.createElement('div');
    div.className = 'kar-line' + (line.isLabel ? ' sec-lbl' : '');
    div.id = `kl-${idx}`;

    if (!line.isLabel && line.wordTs?.length) {
      // Render individual word spans for word-by-word highlighting.
      // wordTs has one entry per normalized word; map back to original tokens.
      div.classList.add('kar-has-words');
      const tokens = line.text.split(/\s+/);
      let wtIdx = 0;
      tokens.forEach((token, ti) => {
        if (ti > 0) div.appendChild(document.createTextNode(' '));
        const normT = token.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normT && wtIdx < line.wordTs.length) {
          const span = document.createElement('span');
          span.className = 'kar-word';
          span.dataset.t = line.wordTs[wtIdx];
          span.textContent = token;
          wtIdx++;
          div.appendChild(span);
        } else {
          div.appendChild(document.createTextNode(token));
        }
      });
    } else {
      div.textContent = line.text;
    }

    if (!line.isLabel) div.onclick = () => karTapLine(idx);
    container.appendChild(div);
  });
}

function setKarMode(mode) {
  KAR.mode = mode;
  KAR.currentLine = -1;
  document.getElementById('karModeSyncBtn').classList.toggle('active', mode === 'sync');
  document.getElementById('karModePlayBtn').classList.toggle('active', mode === 'play');
  document.getElementById('karHint').textContent = mode === 'sync'
    ? 'Tap lines while playing to set timestamps'
    : 'Lines highlight automatically during playback';
  renderKarLines();
}

function karLoadUrl() {
  const url = document.getElementById('karAudioUrl').value.trim();
  if (!url) return;
  KAR.audioUrl  = url;
  KAR.audioFile = null;
  const audio = document.getElementById('karAudio');
  audio.src = url;
  audio.load();
  document.getElementById('karAutoSyncBtn').style.display = 'inline-block';
  toast('Audio loading...');
}

function karLoadFile(input) {
  const file = input.files[0];
  if (!file) return;
  KAR.audioFile = file;
  KAR.audioUrl  = '';
  const audio = document.getElementById('karAudio');
  audio.src = URL.createObjectURL(file);
  audio.load();
  document.getElementById('karAutoSyncBtn').style.display = 'inline-block';
  toast('Audio loaded: ' + file.name);
}

function karTogglePlay() {
  const audio = document.getElementById('karAudio');
  const btn = document.getElementById('karPlayBtn');
  if (!audio.src) { toast('Load an audio file or URL first.'); return; }
  if (audio.paused) {
    audio.play().catch(e => toast('Playback error: ' + e.message));
    btn.textContent = '⏸ Pause';
  } else {
    audio.pause();
    btn.textContent = '▶ Play';
  }
}

function karTapLine(idx) {
  if (KAR.mode !== 'sync') return;
  const audio = document.getElementById('karAudio');
  const t = audio.currentTime || 0;
  KAR.lines[idx].timestamp = t;

  const el = document.getElementById(`kl-${idx}`);
  if (el) {
    const orig = el.style.color;
    el.style.color = 'var(--gold)';
    el.style.transition = 'none';
    setTimeout(() => { if (el) { el.style.color = orig; el.style.transition = ''; } }, 400);
  }

  if (KAR.songId) document.getElementById('karSaveBtn').style.display = 'block';
}

function karTick() {
  const audio = document.getElementById('karAudio');
  const t = audio.currentTime;

  const mins = Math.floor(t / 60);
  const secs = Math.floor(t % 60).toString().padStart(2, '0');
  document.getElementById('karTime').textContent = `${mins}:${secs}`;

  if (KAR.mode !== 'play') return;

  // Find the active lyric line by timestamps.
  // A line stays active until the LATER of:
  //   (a) the next line's start time, and
  //   (b) the last word's start time + its estimated duration
  // This prevents switching before all words in the current line have lit up.
  let activeLine = -1;
  const stamped = KAR.lines.map((l, i) => ({ ...l, i })).filter(l => !l.isLabel && l.timestamp !== null);
  for (let j = 0; j < stamped.length; j++) {
    const cur  = stamped[j];
    const next = stamped[j + 1];

    // Hold the current line until 500 ms after the next line's start time.
    // Without this buffer the last 2-3 words of a line never highlight —
    // their timestamps land right at or just before next.timestamp, and the
    // line switches before the word spans get the .on class.
    const SWITCH_BUFFER = 0.5;
    let holdUntil = next ? next.timestamp + SWITCH_BUFFER : Infinity;

    // Also extend until the last word of the line has had time to display
    const ln = KAR.lines[cur.i];
    if (ln.wordTs?.length) {
      const lastWt  = ln.wordTs[ln.wordTs.length - 1];
      const prevWt  = ln.wordTs.length > 1 ? ln.wordTs[ln.wordTs.length - 2] : null;
      const wordDur = prevWt != null ? Math.max(0.15, lastWt - prevWt) : 0.35;
      holdUntil = Math.max(holdUntil, lastWt + wordDur);
    }

    if (t >= cur.timestamp && t < holdUntil) {
      activeLine = cur.i;
    }
  }

  if (activeLine !== KAR.currentLine) {
    // Clear word highlights on line we're leaving
    if (KAR.currentLine >= 0) {
      const prevEl = document.getElementById(`kl-${KAR.currentLine}`);
      if (prevEl) prevEl.querySelectorAll('.kar-word.on').forEach(s => s.classList.remove('on'));
    }

    KAR.currentLine = activeLine;
    KAR.lines.forEach((line, idx) => {
      const el = document.getElementById(`kl-${idx}`);
      if (!el || line.isLabel) return;
      el.classList.remove('active', 'passed');
      if (idx === activeLine) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (line.timestamp !== null && t > line.timestamp) {
        el.classList.add('passed');
      }
    });
  }

  // Word-level highlighting: update every tick on the active line
  if (activeLine >= 0) {
    const el = document.getElementById(`kl-${activeLine}`);
    if (el?.classList.contains('kar-has-words')) {
      el.querySelectorAll('.kar-word').forEach(span => {
        const wt = parseFloat(span.dataset.t);
        if (!isNaN(wt)) span.classList.toggle('on', t >= wt);
      });
    }
  }
}

function karEnded() {
  document.getElementById('karPlayBtn').textContent = '▶ Play';
  KAR.currentLine = -1;
}

async function saveKarSync() {
  if (!KAR.songId) { toast('No song ID — generate and save a song first.'); return; }
  const syncData = JSON.stringify({
    v: 2,
    lines: KAR.lines.map(l => l.timestamp),
    words: KAR.lines.map(l => l.wordTs ?? null)
  });
  try {
    await authFetch('/api/songs', {
      method: 'PATCH',
      body: JSON.stringify({ id: KAR.songId, sync_data: syncData })
    });
    toast('Karaoke sync saved!');
  } catch (e) {
    toast('Error saving sync: ' + e.message);
  }
}

// ── TWEAK & REFINE ──
function toggleRefine() {
  // Kept as no-op — panel is always open when visible; applyPlanUI controls gate vs form
}
async function submitRefine() {
  const instructions = document.getElementById('refineInstructions').value.trim();
  if (!instructions) { toast('Describe what to change first.'); return; }
  if (!APP.lyrics) { toast('Generate a song first.'); return; }

  gaEvent('tweak_refine_used', { mode: 'freeform' });

  const btn = document.getElementById('refineApplyBtn');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const result = await authFetch('/api/refine', {
      method: 'POST',
      body: JSON.stringify({
        lyrics: APP.lyrics,
        instructions,
        genre: APP.genre,
        moods: APP.moods,
        tempo: APP.tempo,
        topic: document.getElementById('topic').value.trim(),
        songId: APP.currentSongId || null
      })
    });

    APP.lyrics = result.lyrics;
    APP.usage = result.usage;
    APP.limit = result.limit;
    APP.plan = result.plan;
    updateUsage();

    renderLyrics(result.lyrics);
    document.getElementById('refineRevertBtn').classList.add('on');
    toast('Lyrics refined!');
  } catch (e) {
    if (e.message !== 'Monthly limit reached') toast('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Changes';
  }
}

function revertLyrics() {
  if (!APP.originalLyrics) return;
  APP.lyrics = APP.originalLyrics;
  renderLyrics(APP.originalLyrics);
  document.getElementById('refineRevertBtn').classList.remove('on');
  document.getElementById('refineInstructions').value = '';
  toast('Reverted to original lyrics.');
}

// ══════════════════════════════════════════════════════════
//  CHORD PARSING + TRANSPOSE + DIAGRAMS
// ══════════════════════════════════════════════════════════

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT_TO_SHARP = {Db:'C#',Eb:'D#',Fb:'E',Gb:'F#',Ab:'G#',Bb:'A#',Cb:'B'};

function normalizeRoot(r) { return FLAT_TO_SHARP[r] || r; }

function transposeChord(chord, semitones) {
  if (!chord || !chord.trim() || semitones === 0) return chord;
  // Match root (e.g. C#, Db, C) then quality
  const m = chord.match(/^([A-G][#b]?)(.*)/);
  if (!m) return chord;
  const root = normalizeRoot(m[1]);
  const quality = m[2];
  const idx = CHROMATIC.indexOf(root);
  if (idx === -1) return chord;
  const newIdx = ((idx + semitones) % 12 + 12) % 12;
  return CHROMATIC[newIdx] + quality;
}

function parseChordData(raw) {
  if (!raw) return null;
  const result = { key: '', strumming: '', sections: {} };
  raw.split('\n').forEach(line => {
    line = line.trim();
    if (!line) return;
    if (line.startsWith('KEY:')) {
      result.key = line.replace('KEY:', '').trim();
    } else if (line.startsWith('STRUMMING:')) {
      result.strumming = line.replace('STRUMMING:', '').trim();
    } else if (line.includes(':')) {
      const ci = line.indexOf(':');
      const sect = line.substring(0, ci).trim().toUpperCase();
      const chordsStr = line.substring(ci + 1).trim();
      // Split on em dash, en dash, or spaced hyphen
      result.sections[sect] = chordsStr.split(/\s*[—–]\s*|\s+-\s+/).map(c => c.trim()).filter(Boolean);
    }
  });
  return result;
}

function getTransposedChordsText() {
  if (!APP.rawChords) return '';
  if (APP.transposeOffset === 0) return APP.rawChords;
  return APP.rawChords.split('\n').map(line => {
    if (line.startsWith('KEY:')) {
      return 'KEY: ' + transposeChord(line.replace('KEY:', '').trim(), APP.transposeOffset);
    }
    if (line.startsWith('STRUMMING:')) return line;
    if (line.includes(':')) {
      const ci = line.indexOf(':');
      const sect = line.substring(0, ci);
      const chordsStr = line.substring(ci + 1).trim();
      const transposed = chordsStr.split(/\s*[—–]\s*|\s+-\s+/)
        .map(c => transposeChord(c.trim(), APP.transposeOffset)).join(' — ');
      return sect + ': ' + transposed;
    }
    return line;
  }).join('\n');
}

function getInlineSectionChords(sectionName) {
  if (!APP.parsedChords || !sectionName) return [];
  const s = APP.parsedChords.sections;
  // Exact match
  if (s[sectionName]) return applyTransposeToChords(s[sectionName]);
  // Prefix match: "VERSE" matches "VERSE 1", "VERSE 2"
  const prefix = sectionName.replace(/\s+\d+$/, '').trim();
  for (const key of Object.keys(s)) {
    if (key === prefix || key.startsWith(prefix + ' ')) {
      return applyTransposeToChords(s[key]);
    }
  }
  return [];
}

function applyTransposeToChords(chords) {
  if (APP.transposeOffset === 0) return chords;
  return chords.map(c => transposeChord(c, APP.transposeOffset));
}

function toggleShowChords() {
  APP.showChords = !APP.showChords;
  const btn = document.getElementById('showChordsBtn');
  const tc = document.getElementById('transposeCtrl');
  const cg = document.getElementById('chordGuide');
  const cpb = document.getElementById('chordProgressionBlock');
  const out = document.getElementById('lyricsOut');
  const tr = I18N[APP.uiLang] || I18N.en;
  if (btn) {
    btn.classList.toggle('on', APP.showChords);
    btn.textContent = APP.showChords ? (tr['chord.hide_chords']||'Hide Chords') : (tr['chord.show_chords']||'Show Chords');
  }
  if (tc) tc.style.display = APP.showChords ? 'flex' : 'none';
  // Hide chord progression block when inline mode is on; show chord guide instead
  if (cpb) cpb.style.display = APP.showChords ? 'none' : 'block';
  if (cg) cg.style.display = APP.showChords ? 'block' : 'none';
  // Toggle lead-sheet class on the notebook output
  if (out) out.classList.toggle('chord-mode', APP.showChords);
  if (APP.lyrics) renderLyrics(APP.lyrics);
  if (APP.showChords) renderChordDiagrams();
}

function transposeUp() {
  APP.transposeOffset = ((APP.transposeOffset + 1) % 12 + 12) % 12;
  applyTranspose();
}
function transposeDown() {
  APP.transposeOffset = ((APP.transposeOffset - 1) % 12 + 12) % 12;
  applyTranspose();
}
function applyTranspose() {
  const keyEl = document.getElementById('trKeyDisplay');
  if (keyEl && APP.parsedChords?.key) {
    keyEl.textContent = transposeChord(APP.parsedChords.key, APP.transposeOffset);
  }
  updateChordDisplay();
  if (APP.showChords && APP.lyrics) renderLyrics(APP.lyrics);
  if (APP.showChords) renderChordDiagrams();
}

// ── CHORD DIAGRAMS ──
// Strings: [low-E, A, D, G, B, high-e] — -1=muted, 0=open, N=fret
const CHORD_SHAPES = {
  'C':    {s:[-1,3,2,0,1,0]},
  'Cm':   {s:[-1,3,5,5,4,3],barre:{f:3,from:1,to:5},startFret:3},
  'C7':   {s:[-1,3,2,3,1,0]},
  'Cmaj7':{s:[-1,3,2,0,0,0]},
  'Cm7':  {s:[-1,3,5,3,4,3],barre:{f:3,from:1,to:5},startFret:3},
  'D':    {s:[-1,-1,0,2,3,2]},
  'Dm':   {s:[-1,-1,0,2,3,1]},
  'D7':   {s:[-1,-1,0,2,1,2]},
  'Dmaj7':{s:[-1,-1,0,2,2,2]},
  'Dm7':  {s:[-1,-1,0,2,1,1]},
  'E':    {s:[0,2,2,1,0,0]},
  'Em':   {s:[0,2,2,0,0,0]},
  'E7':   {s:[0,2,0,1,0,0]},
  'Emaj7':{s:[0,2,1,1,0,0]},
  'Em7':  {s:[0,2,2,0,3,0]},
  'F':    {s:[1,1,2,3,3,1],barre:{f:1,from:0,to:5}},
  'Fm':   {s:[1,1,3,3,2,1],barre:{f:1,from:0,to:5}},
  'F7':   {s:[1,1,2,1,1,1],barre:{f:1,from:0,to:5}},
  'Fmaj7':{s:[-1,0,3,2,1,0]},
  'Fm7':  {s:[1,1,3,1,2,1],barre:{f:1,from:0,to:5}},
  'F#':   {s:[2,2,3,4,4,2],barre:{f:2,from:0,to:5},startFret:2},
  'F#m':  {s:[2,2,4,4,3,2],barre:{f:2,from:0,to:5},startFret:2},
  'F#7':  {s:[2,2,3,2,2,2],barre:{f:2,from:0,to:5},startFret:2},
  'F#m7': {s:[2,2,4,2,3,2],barre:{f:2,from:0,to:5},startFret:2},
  'G':    {s:[3,2,0,0,0,3]},
  'Gm':   {s:[3,5,5,3,3,3],barre:{f:3,from:0,to:5},startFret:3},
  'G7':   {s:[3,2,0,0,0,1]},
  'Gmaj7':{s:[3,2,0,0,0,2]},
  'G#':   {s:[4,4,6,6,6,4],barre:{f:4,from:0,to:5},startFret:4},
  'G#m':  {s:[4,4,6,6,5,4],barre:{f:4,from:0,to:5},startFret:4},
  'Ab':   {s:[4,4,6,6,6,4],barre:{f:4,from:0,to:5},startFret:4},
  'Abm':  {s:[4,4,6,6,5,4],barre:{f:4,from:0,to:5},startFret:4},
  'A':    {s:[-1,0,2,2,2,0]},
  'Am':   {s:[-1,0,2,2,1,0]},
  'A7':   {s:[-1,0,2,0,2,0]},
  'Amaj7':{s:[-1,0,2,1,2,0]},
  'Am7':  {s:[-1,0,2,0,1,0]},
  'A#':   {s:[-1,1,3,3,3,1],barre:{f:1,from:1,to:5},startFret:1},
  'A#m':  {s:[-1,1,3,3,2,1],barre:{f:1,from:1,to:5},startFret:1},
  'Bb':   {s:[-1,1,3,3,3,1],barre:{f:1,from:1,to:5},startFret:1},
  'Bbm':  {s:[-1,1,3,3,2,1],barre:{f:1,from:1,to:5},startFret:1},
  'B':    {s:[-1,2,4,4,4,2],barre:{f:2,from:1,to:5},startFret:2},
  'Bm':   {s:[-1,2,4,4,3,2],barre:{f:2,from:1,to:5},startFret:2},
  'B7':   {s:[-1,2,1,2,0,2]},
  'Bmaj7':{s:[-1,2,4,3,4,2],barre:{f:2,from:1,to:5},startFret:2},
  'Bm7':  {s:[-1,2,4,2,3,2],barre:{f:2,from:1,to:5},startFret:2},
  'C#':   {s:[-1,4,6,6,6,4],barre:{f:4,from:1,to:5},startFret:4},
  'C#m':  {s:[-1,4,6,6,5,4],barre:{f:4,from:1,to:5},startFret:4},
  'D#':   {s:[-1,1,3,3,3,1],barre:{f:1,from:1,to:5},startFret:1},
  'D#m':  {s:[-1,1,3,3,2,1],barre:{f:1,from:1,to:5},startFret:1},
  'Eb':   {s:[-1,1,3,3,3,1],barre:{f:1,from:1,to:5},startFret:1},
  'Ebm':  {s:[-1,1,3,3,2,1],barre:{f:1,from:1,to:5},startFret:1},
};

function renderChordDiagramSVG(chordName) {
  const shape = CHORD_SHAPES[chordName];
  const W=72, H=92;
  const pL=14, pR=8, pT=20, pB=8;
  const gW=W-pL-pR, gH=H-pT-pB;
  const nStr=6, nFrets=4;
  const sSpace=gW/(nStr-1), fSpace=gH/nFrets;
  if (!shape) {
    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#1c1b22" rx="4"/><text x="${W/2}" y="${H/2+4}" text-anchor="middle" font-size="10" fill="#524e4a" font-family="DM Sans,sans-serif">?</text></svg>`;
  }
  const {s, barre, startFret=1} = shape;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // Background
  svg += `<rect width="${W}" height="${H}" fill="#151419" rx="4"/>`;
  // Nut (only for open position chords)
  if (startFret === 1) svg += `<rect x="${pL}" y="${pT-3}" width="${gW}" height="3" fill="#9b9490" rx="1"/>`;
  // Fret lines
  for (let f=0; f<=nFrets; f++) {
    const y = pT + f*fSpace;
    svg += `<line x1="${pL}" y1="${y}" x2="${pL+gW}" y2="${y}" stroke="#2a2830" stroke-width="${f===0?0:'1'}"/>`;
  }
  // String lines
  for (let str=0; str<nStr; str++) {
    const x = pL + str*sSpace;
    svg += `<line x1="${x}" y1="${pT}" x2="${x}" y2="${pT+gH}" stroke="#3a3840" stroke-width="1.2"/>`;
  }
  // Barre bar
  if (barre) {
    const relF = barre.f - startFret;
    if (relF >= 0 && relF < nFrets) {
      const by = pT + relF*fSpace + fSpace/2;
      const bx1 = pL + barre.from*sSpace;
      const bx2 = pL + barre.to*sSpace;
      svg += `<line x1="${bx1}" y1="${by}" x2="${bx2}" y2="${by}" stroke="#c9943a" stroke-width="${fSpace*0.5}" stroke-linecap="round" opacity=".85"/>`;
    }
  }
  // Open / muted indicators
  for (let str=0; str<nStr; str++) {
    const x = pL + str*sSpace;
    if (s[str] === -1) {
      svg += `<text x="${x}" y="${pT-6}" text-anchor="middle" font-size="8" fill="#524e4a" font-family="DM Sans,sans-serif">✕</text>`;
    } else if (s[str] === 0) {
      svg += `<circle cx="${x}" cy="${pT-7}" r="3.5" fill="none" stroke="#9b9490" stroke-width="1.2"/>`;
    }
  }
  // Finger dots
  for (let str=0; str<nStr; str++) {
    const fret = s[str];
    if (fret > 0) {
      const relF = fret - startFret;
      if (relF >= 0 && relF < nFrets) {
        const dx = pL + str*sSpace;
        const dy = pT + relF*fSpace + fSpace/2;
        svg += `<circle cx="${dx}" cy="${dy}" r="${fSpace*0.27}" fill="#c9943a"/>`;
      }
    }
  }
  // Start fret label
  if (startFret > 1) {
    svg += `<text x="${pL-3}" y="${pT+fSpace*0.65}" text-anchor="end" font-size="7" fill="#9b9490" font-family="DM Mono,monospace">${startFret}fr</text>`;
  }
  svg += '</svg>';
  return svg;
}

function getUniqueChordsFromSong() {
  if (!APP.parsedChords) return [];
  const seen = new Set();
  const chords = [];
  for (const sect of Object.values(APP.parsedChords.sections)) {
    for (const ch of sect) {
      const transposed = transposeChord(ch, APP.transposeOffset);
      if (!seen.has(transposed)) { seen.add(transposed); chords.push(transposed); }
    }
  }
  return chords;
}

function renderChordDiagrams() {
  const grid = document.getElementById('chordDiagramsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const chords = getUniqueChordsFromSong();
  chords.forEach(chord => {
    const item = document.createElement('div');
    item.className = 'chord-diagram-item';
    item.innerHTML = renderChordDiagramSVG(chord);
    const label = document.createElement('div');
    label.className = 'chord-diagram-label';
    label.textContent = chord;
    item.appendChild(label);
    grid.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════════
//  i18n — MULTI-LANGUAGE UI
// ══════════════════════════════════════════════════════════

// ── FIELD TOOLTIPS ──
(function(){
  const pop = document.createElement('div');
  pop.id = 'tipPopup';
  document.body.appendChild(pop);
  let cur = null;
  document.addEventListener('click', e => {
    const btn = e.target.closest('.field-tip');
    if (btn) {
      e.stopPropagation();
      if (cur === btn) { hideTip(); return; }
      cur = btn;
      pop.textContent = btn.dataset.tip;
      pop.style.display = 'block';
      const r = btn.getBoundingClientRect();
      let left = r.left, top = r.bottom + 8;
      if (left + 288 > window.innerWidth - 8) left = window.innerWidth - 288 - 8;
      if (left < 8) left = 8;
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      return;
    }
    hideTip();
  });
  function hideTip(){ cur = null; pop.style.display = 'none'; }
})();

// ── ONBOARDING WIZARD ──
const WIZARD_TILES = [
  { emoji:'💔', label:'Love &\nHeartbreak', topic:"The moment I realized I still wasn't over them",    genre:'R&B',          moods:['Heartbroken'] },
  { emoji:'🔥', label:'Hype\nAnthem',       topic:"Proving everyone who doubted me wrong",             genre:'Rap / Hip Hop', moods:['Defiant']     },
  { emoji:'🤠', label:'Country\nStory',     topic:"A small-town summer night that changed everything", genre:'Country',       moods:['Nostalgic']   },
  { emoji:'🎸', label:'Rock\nIt Out',       topic:"Breaking free and not looking back",                genre:'Rock',          moods:['Raw']          },
  { emoji:'🎲', label:'Surprise\nMe',       random:true }
];
let _wizardTile = null;

function maybeShowWizardOrFork() {
  if (APP.usage === 0 && APP.totalSongs === 0) {
    showWizard();
  } else {
    showFork();
  }
}

function showWizard() {
  const tilesEl = document.getElementById('wizardTiles');
  tilesEl.innerHTML = '';
  _wizardTile = null;
  document.getElementById('wizardGenBtn').classList.remove('ready');
  WIZARD_TILES.forEach(tile => {
    const btn = document.createElement('button');
    btn.className = 'wizard-tile';
    btn.innerHTML = `<span class="wizard-tile-emoji">${tile.emoji}</span><span class="wizard-tile-label">${tile.label.replace('\n','<br>')}</span>`;
    btn.onclick = () => selectWizardTile(btn, tile);
    tilesEl.appendChild(btn);
  });
  document.getElementById('wizardOverlay').classList.remove('hidden');
}

function selectWizardTile(btn, tile) {
  document.querySelectorAll('.wizard-tile').forEach(t => t.classList.remove('selected'));
  btn.classList.add('selected');
  if (tile.random) {
    const pool = WIZARD_TILES.filter(t => !t.random);
    _wizardTile = pool[Math.floor(Math.random() * pool.length)];
  } else {
    _wizardTile = tile;
  }
  document.getElementById('wizardGenBtn').classList.add('ready');
}

function wizardGenerate() {
  if (!_wizardTile) return;
  const tile = _wizardTile;
  document.getElementById('topic').value = tile.topic;
  APP.advGenres = [tile.genre];
  APP.genre = tile.genre;
  document.querySelectorAll('#genreGrid .pick-btn').forEach(b => b.classList.toggle('on', b.dataset.v === tile.genre));
  APP.moods = [...tile.moods];
  document.querySelectorAll('#moodGrid .mood-chip').forEach(b => b.classList.toggle('on', tile.moods.includes(b.dataset.v)));
  APP._firstSongPending = true;
  document.getElementById('wizardOverlay').classList.add('hidden');
  generate();
}

function dismissWizard() {
  document.getElementById('wizardOverlay').classList.add('hidden');
}

function showFork() {
  document.getElementById('forkModal').classList.add('on');
}

function forkChoose(mode) {
  document.getElementById('forkModal').classList.remove('on');
  if (mode === 'quick') showWizard();
}

function launchConfetti() {
  const wrap = document.getElementById('confettiWrap');
  const colors = ['#c9943a','#e8b84b','#f5d98b','#a87828','#d4a853','#fff8e7'];
  wrap.innerHTML = '';
  wrap.classList.add('on');
  for (let i = 0; i < 65; i++) {
    const el = document.createElement('div');
    el.className = 'cp';
    const size = (Math.random() * 8 + 5).toFixed(1);
    el.style.cssText = `left:${(Math.random()*100).toFixed(1)}vw;width:${size}px;height:${size}px;background:${colors[Math.floor(Math.random()*colors.length)]};border-radius:${Math.random()>.5?'50%':'2px'};animation-duration:${(Math.random()*2+1.5).toFixed(2)}s;animation-delay:${(Math.random()*.9).toFixed(2)}s`;
    wrap.appendChild(el);
  }
  toast('🎵 Your first song is ready!');
  setTimeout(() => { wrap.classList.remove('on'); wrap.innerHTML = ''; }, 3800);
}

