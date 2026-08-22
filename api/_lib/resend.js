// Read at call time, not module load time — ensures Vercel env vars are always current
function getKey() { return process.env.RESEND_API_KEY; }

const FROM = 'Scott at WriteMyLyrics <support@writemylyrics.ai>';
const APP_URL = 'https://writemylyrics.ai';

async function resendRequest(path, body) {
  const key = getKey();
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set — skipping email');
    return null;
  }
  console.log(`[resend] sending to ${path}`, { to: body.to, subject: body.subject, scheduled_at: body.scheduled_at || 'immediate' });
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[resend] ${path} failed (${res.status}):`, JSON.stringify(data));
    return null;
  }
  console.log(`[resend] success — email id: ${data.id}`);
  return data;
}

// Cancel a scheduled email by ID — called when user generates their first song
async function cancelEmail(emailId) {
  const key = getKey();
  if (!key || !emailId) return;
  const res = await fetch(`https://api.resend.com/emails/${emailId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[resend] cancel ${emailId} failed (${res.status}):`, body);
  }
}

function emailWrapper(content) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0c10;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0c10;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#18161e;border:1px solid #2a2535;border-radius:12px;overflow:hidden">
        <tr>
          <td style="padding:32px 36px 0">
            <p style="margin:0 0 24px;font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#c9943a;letter-spacing:.02em">WriteMyLyrics</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 36px;color:#c8c4d4;font-size:15px;line-height:1.75">
            ${content}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 36px;border-top:1px solid #2a2535;font-size:12px;color:#6b6480">
            WriteMyLyrics · <a href="${APP_URL}" style="color:#c9943a;text-decoration:none">writemylyrics.ai</a> ·
            You're receiving this because you signed up for WriteMyLyrics.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(text, url) {
  return `<p style="margin:28px 0 0">
    <a href="${url}" style="display:inline-block;background:#c9943a;color:#07060a;font-weight:700;font-size:14px;padding:13px 28px;border-radius:7px;text-decoration:none;letter-spacing:.03em">${text}</a>
  </p>`;
}

// ── EMAIL 1 — immediate welcome ───────────────────────────────────────────────
async function sendWelcomeEmail(toEmail, name) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = emailWrapper(`
    <p style="margin:0 0 16px;font-size:17px;font-weight:600;color:#f0edf8">Hey ${firstName},</p>
    <p style="margin:0 0 16px">I'm Scott — the founder of WriteMyLyrics. Welcome, and thanks for signing up.</p>
    <p style="margin:0 0 16px">Here's all you need to do to generate your first song:</p>
    <ol style="margin:0 0 16px;padding-left:22px">
      <li style="margin-bottom:10px">Type what your song is about in the <strong style="color:#f0edf8">Topic</strong> field</li>
      <li style="margin-bottom:10px">Pick a genre and mood if you want — or leave them blank</li>
      <li>Hit <strong style="color:#c9943a">Write This Song</strong></li>
    </ol>
    <p style="margin:0 0 16px">That's it. You get complete lyrics in about 20 seconds — verse, chorus, bridge, chord progressions, everything.</p>
    <p style="margin:0 0 0">You've got 5 free songs this month. Make them count.</p>
    ${ctaButton('Write Your First Song →', APP_URL)}
    <p style="margin:32px 0 0;color:#a09ab8">— Scott<br><span style="font-size:13px;color:#6b6480">Founder, WriteMyLyrics</span></p>
  `);

  return resendRequest('/emails', {
    from: FROM,
    to: [toEmail],
    subject: 'Welcome to WriteMyLyrics — let\'s write your first song',
    html,
  });
}

// ── EMAIL 2 — 48 hour nudge (only if no songs generated) ─────────────────────
async function scheduleNudgeEmail(toEmail, name, signupTime) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const sendAt = new Date(signupTime.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const html = emailWrapper(`
    <p style="margin:0 0 16px;font-size:17px;font-weight:600;color:#f0edf8">Hey ${firstName},</p>
    <p style="margin:0 0 16px">You signed up for WriteMyLyrics a couple days ago. If you haven't had a chance to write anything yet, here's a quick starting point:</p>
    <p style="margin:0 0 16px;padding:16px 20px;background:#0d0c10;border-left:3px solid #c9943a;border-radius:4px;font-style:italic;color:#f0edf8">
      "A song about leaving home for the first time"
    </p>
    <p style="margin:0 0 16px">Paste that into the Topic field, pick <strong style="color:#f0edf8">Country</strong> or <strong style="color:#f0edf8">Singer-Songwriter</strong>, and hit Write This Song. You'll have a full song in about 20 seconds.</p>
    <p style="margin:0 0 0">Or use whatever's actually on your mind — that always works better anyway.</p>
    ${ctaButton('Go Write Your First Song →', APP_URL)}
    <p style="margin:32px 0 0;color:#a09ab8">— Scott</p>
  `);

  return resendRequest('/emails', {
    from: FROM,
    to: [toEmail],
    subject: 'Your first song is waiting',
    html,
    scheduled_at: sendAt,
  });
}

// ── NURTURE DAY 3 — zero-song users only ─────────────────────────────────────
async function sendDay3Email(toEmail, name) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = emailWrapper(`
    <p style="margin:0 0 16px;font-size:17px;font-weight:600;color:#f0edf8">Hey ${firstName},</p>
    <p style="margin:0 0 16px">You signed up a few days ago. I noticed you haven't written anything yet.</p>
    <p style="margin:0 0 16px">That's fine — it can feel like a bigger lift than it actually is. Here's something to paste into the Topic field right now:</p>
    <p style="margin:0 0 16px;padding:16px 20px;background:#0d0c10;border-left:3px solid #c9943a;border-radius:4px;font-style:italic;color:#f0edf8">
      "A song about leaving something behind"
    </p>
    <p style="margin:0 0 16px">Pick any genre, hit <strong style="color:#c9943a">Write This Song</strong>. Full lyrics in about 20 seconds. See how it feels.</p>
    <p style="margin:0 0 0">You've still got your 5 free songs.</p>
    ${ctaButton('Write Your First Song →', APP_URL)}
    <p style="margin:32px 0 0;color:#a09ab8">— Scott<br><span style="font-size:13px;color:#6b6480">Founder, WriteMyLyrics</span></p>
  `);

  return resendRequest('/emails', {
    from: FROM,
    to: [toEmail],
    subject: 'You haven\'t written a song yet',
    html,
  });
}

// ── NURTURE DAY 7 — Pro feature showcase ─────────────────────────────────────
async function sendDay7Email(toEmail, name) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = emailWrapper(`
    <p style="margin:0 0 16px;font-size:17px;font-weight:600;color:#f0edf8">Hey ${firstName},</p>
    <p style="margin:0 0 16px">A week in. If you've been on the free plan, here are three things you're missing:</p>
    <p style="margin:0 0 8px"><strong style="color:#f0edf8">Karaoke Mode</strong> — sync your lyrics to your voice, word by word. Use it to practice performing before you hit record.</p>
    <p style="margin:0 0 8px"><strong style="color:#f0edf8">Quick Refine</strong> — highlight any section, tell it what to change, and it rewrites just that part while leaving everything else intact.</p>
    <p style="margin:0 0 16px"><strong style="color:#f0edf8">Shareable Links</strong> — send your song to anyone. No account required to view it.</p>
    <p style="margin:0 0 0">All of that is $15/month. No contract, cancel anytime.</p>
    ${ctaButton('See What Pro Unlocks →', `${APP_URL}/pricing`)}
    <p style="margin:32px 0 0;color:#a09ab8">— Scott<br><span style="font-size:13px;color:#6b6480">Founder, WriteMyLyrics</span></p>
  `);

  return resendRequest('/emails', {
    from: FROM,
    to: [toEmail],
    subject: '3 things Pro unlocks',
    html,
  });
}

// ── NURTURE DAY 14 — re-engagement + upgrade push ────────────────────────────
async function sendDay14Email(toEmail, name) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = emailWrapper(`
    <p style="margin:0 0 16px;font-size:17px;font-weight:600;color:#f0edf8">Hey ${firstName},</p>
    <p style="margin:0 0 16px">Two weeks since you signed up. Quick check-in.</p>
    <p style="margin:0 0 16px">If you've been bumping into the 5-song limit, <strong style="color:#f0edf8">Pro</strong> removes it entirely — unlimited songs, full history, Karaoke Mode, Quick Refine, shareable links, and a commercial use license.</p>
    <p style="margin:0 0 16px">If you haven't written much yet — no judgment. The tool is here whenever you're ready.</p>
    <p style="margin:0 0 0">Pro is $15/month. No contract.</p>
    ${ctaButton('Upgrade to Pro →', `${APP_URL}/pricing`)}
    <p style="margin:32px 0 0;color:#a09ab8">— Scott<br><span style="font-size:13px;color:#6b6480">Founder, WriteMyLyrics</span></p>
  `);

  return resendRequest('/emails', {
    from: FROM,
    to: [toEmail],
    subject: 'Still writing?',
    html,
  });
}

module.exports = {
  sendWelcomeEmail,
  scheduleNudgeEmail,
  sendDay3Email,
  sendDay7Email,
  sendDay14Email,
  cancelEmail,
};
