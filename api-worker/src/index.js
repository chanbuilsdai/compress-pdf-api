// editpdf.tools Compress PDF API - Cloudflare Worker (api.editpdf.tools)
// - Public API: POST /v1/compress, GET /v1/me
// - Users: email link login (no passwords), one API key per user, dashboard
// - Admin: /admin, email-link login only for ADMIN_EMAILS (no Cloudflare Access needed)
// - Own D1 database. Does not touch the website or its Supabase.
// License: AGPL-3.0-only

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 10 * MB;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 1.5 * MB; // multipart overhead
const TOKEN_TTL = 20 * 60;          // email link valid 20 min
const SESSION_TTL = 7 * 24 * 3600;  // 7 days
const RATE_WINDOW = 60;             // 1 file per minute per user

// ---------- small helpers ----------
const now = () => Math.floor(Date.now() / 1000);
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function sameOrigin(req) {
  // Browsers may send "Origin: null" for form posts; then fall back to Sec-Fetch-Site.
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'null') return origin === new URL(req.url).origin;
  return req.headers.get('Sec-Fetch-Site') === 'same-origin';
}
function clientIp(req) { return req.headers.get('CF-Connecting-IP') || 'unknown'; }
const isLocal = (req) => ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);

// ---------- D1 counters ----------
async function bump(env, name, by, expiresAt) {
  const row = await env.DB.prepare(
    'INSERT INTO counters (name, value, expires_at) VALUES (?1, ?2, ?3) ' +
    'ON CONFLICT(name) DO UPDATE SET value = value + excluded.value RETURNING value'
  ).bind(name, by, expiresAt).first();
  return row ? row.value : by;
}
async function counter(env, name) {
  const row = await env.DB.prepare('SELECT value FROM counters WHERE name = ?1').bind(name).first();
  return row ? row.value : 0;
}
async function audit(env, actor, action, detail) {
  await env.DB.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(now(), actor, action, detail ? String(detail).slice(0, 500) : null).run();
}

// ---------- HTML ----------
const CSP = [
  "default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data:",
  'script-src https://challenges.cloudflare.com', 'frame-src https://challenges.cloudflare.com',
  'connect-src https://challenges.cloudflare.com', "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

function page(title, body, status = 200, extraHeaders = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | editpdf.tools API</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--ink:#16181d;--muted:#5d6370;--line:#e3e5e9;--accent:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1b1d22;--ink:#eceef2;--muted:#a3a9b5;--line:#2c2f36;--accent:#ef5350}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem}.muted{color:var(--muted)}
input,button,select{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button{background:var(--accent);color:#fff;border:0;cursor:pointer}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
code,pre{font-family:ui-monospace,Consolas,monospace;font-size:.9em}pre{background:var(--bg);border:1px solid var(--line);padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:.92em}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ok{color:#2e7d32}.bad{color:var(--accent)}
</style></head><body><main>
<p class="muted"><a href="https://editpdf.tools/">editpdf.tools</a> · Compress PDF API</p>
${body}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', ...extraHeaders,
    },
  });
}

// ---------- config ----------
function cfg(env) {
  return {
    defaultQuota: num(env.DEFAULT_MONTHLY_QUOTA, 30),
    globalFiles: num(env.GLOBAL_MONTHLY_FILES, 1000),
    globalBytes: num(env.GLOBAL_MONTHLY_BYTES_OUT, 4 * 1024 * MB),
    emailDailyCap: num(env.EMAIL_DAILY_CAP, 40),
    signupsPerIpHour: num(env.SIGNUPS_PER_IP_HOUR, 5),
    paused: env.API_PAUSED === 'true',
  };
}

// ---------- email ----------
async function sendLoginEmail(env, req, to, link, kind = 'user') {
  if (env.EMAIL_MODE === 'log' && isLocal(req)) { console.log('DEV LOGIN LINK for', to, link); return true; }
  if (!env.RESEND_API_KEY) return false;
  const admin = kind === 'admin';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'editpdf.tools API <noreply@editpdf.tools>',
      to: [to],
      subject: admin ? 'editpdf.tools API admin sign-in link' : 'Your editpdf.tools API sign-in link',
      text: admin
        ? `Admin sign-in for the editpdf.tools Compress PDF API:\n\n${link}\n\nThe link works once and expires in 10 minutes. If you did not ask for it, someone pressed the admin sign-in button. No action is needed, but tell the team.`
        : `Use this link to sign in to the editpdf.tools Compress PDF API dashboard:\n\n${link}\n\nThe link works once and expires in 20 minutes. If you did not ask for it, ignore this email.`,
    }),
  });
  return r.ok;
}

async function verifyTurnstile(env, req, token) {
  if (!env.TURNSTILE_SECRET) return false;
  if (env.TURNSTILE_SECRET === 'local-test' && isLocal(req)) return true; // local dev only
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token || '');
  form.append('remoteip', clientIp(req));
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const d = await r.json().catch(() => ({}));
  return d.success === true;
}

// ---------- sessions ----------
async function currentUser(env, req) {
  const sid = cookie(req, '__Host-sid');
  if (!sid) return null;
  const row = await env.DB.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid_hash = ?1 AND s.expires_at > ?2'
  ).bind(await sha256(sid), now()).first();
  return row && row.status === 'active' ? row : null;
}

// ---------- pages ----------
function landing(env) {
  const c = cfg(env);
  return page('Compress PDF API', `
<h1>Compress PDF API</h1>
<p>Compress PDF files from your own app, Zapier-style automations or scripts. Files are processed on our server and deleted right after the response. Nothing is stored.</p>
<div class="card"><h2>Free plan</h2><ul>
<li>${c.defaultQuota} files per month, 1 file per minute</li><li>Max file size 10 MB</li><li>Levels: light, recommended, strong</li></ul>
<p><a href="/signup">Get a free API key</a> · <a href="/dashboard">Dashboard</a></p></div>
<div class="card"><h2>Example</h2>
<pre>curl -X POST https://api.editpdf.tools/v1/compress \\
  -H "X-API-Key: YOUR_KEY" \\
  -F "file=@input.pdf" -F "level=recommended" \\
  -o compressed.pdf</pre>
<p class="muted">Response: the compressed PDF. Headers X-Original-Size, X-Compressed-Size, X-Quota-Remaining. Errors are JSON.</p>
<p class="muted">Check your key: <code>GET /v1/me</code> with the same header.</p></div>
<p class="muted">Source code (AGPL-3.0). Uses Ghostscript (AGPL, Artifex Software). Support: <a href="https://editpdf.tools/contact">editpdf.tools/contact</a></p>`);
}

function signupForm(env, msg = '') {
  return page('Get an API key', `
<h1>Get a free API key</h1>
<p>Enter your email. We send a one-time sign-in link. No password.</p>
${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
<form class="card" method="post" action="/signup">
<label>Email<br><input type="email" name="email" required maxlength="254" autocomplete="email" style="width:100%"></label>
<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY || '')}" style="margin:12px 0"></div>
<button type="submit">Send sign-in link</button></form>
<p class="muted">By signing up you agree to use the API fairly. Abuse leads to a block. Existing users use the same form to sign in.</p>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
}

const SENT_MSG = () => page('Check your email', `<h1>Check your email</h1>
<p>If the address is valid, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
<p class="muted">No email after a few minutes? Check spam, or try again later.</p>`);

async function handleSignup(env, req) {
  if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
  const c = cfg(env);
  const form = await req.formData().catch(() => null);
  if (!form) return signupForm(env, 'Bad request.');
  const email = String(form.get('email') || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return signupForm(env, 'Please enter a valid email.');
  if (!(await verifyTurnstile(env, req, form.get('cf-turnstile-response')))) return signupForm(env, 'Bot check failed. Please try again.');

  const t = now();
  const hour = Math.floor(t / 3600);
  const ipHash = (await sha256('ip:' + clientIp(req) + (env.HASH_SALT || ''))).slice(0, 24);
  if ((await bump(env, `ip:${ipHash}:${hour}`, 1, t + 7200)) > c.signupsPerIpHour) return SENT_MSG();
  const emailHash = (await sha256('em:' + email)).slice(0, 24);
  if ((await bump(env, `em:${emailHash}:${hour}`, 1, t + 7200)) > 3) return SENT_MSG();
  if ((await counter(env, `emails:${dayKey()}`)) >= c.emailDailyCap) {
    return page('Busy', '<h1>Daily limit reached</h1><p>We send a limited number of sign-in emails per day. Please try again tomorrow.</p>', 429);
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  if (user && user.status === 'blocked') return SENT_MSG(); // do not reveal
  if (!user) {
    user = { id: crypto.randomUUID(), email };
    await env.DB.prepare('INSERT INTO users (id, email, status, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(user.id, email, 'pending', t).run();
  }
  const token = randomToken();
  await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(token), user.id, t + TOKEN_TTL).run();
  const link = `${new URL(req.url).origin}/auth?t=${token}`;
  if (await sendLoginEmail(env, req, email, link)) await bump(env, `emails:${dayKey()}`, 1, t + 3 * 86400);
  return SENT_MSG();
}

async function handleAuth(env, req) {
  const token = new URL(req.url).searchParams.get('t') || '';
  // Show a confirm button first, so email scanners that open links do not use up the token.
  if (req.method === 'GET') {
    return page('Sign in', `<h1>Sign in</h1><form class="card" method="post" action="/auth?t=${esc(encodeURIComponent(token))}">
<p>Click to finish signing in.</p><button type="submit">Continue to dashboard</button></form>`);
  }
  if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
  const t = now();
  const row = await env.DB.prepare(
    "UPDATE tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 AND user_id NOT LIKE 'admin:%' RETURNING user_id"
  ).bind(t, await sha256(token)).first();
  if (!row) return page('Link expired', '<h1>This link has expired or was already used</h1><p><a href="/signup">Get a new link</a></p>', 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(row.user_id).first();
  if (!user || user.status === 'blocked') return page('Blocked', '<h1>Access not available</h1>', 403);
  if (user.status === 'pending') {
    await env.DB.prepare("UPDATE users SET status = 'active', verified_at = ?1 WHERE id = ?2").bind(t, user.id).run();
  }
  const sid = randomToken();
  await env.DB.prepare('INSERT INTO sessions (sid_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(sid), user.id, t + SESSION_TTL).run();
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/dashboard',
      'Set-Cookie': `__Host-sid=${sid}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function dashboard(env, req, user, newKey = null) {
  const c = cfg(env);
  const quota = user.monthly_quota ?? c.defaultQuota;
  const u = await env.DB.prepare('SELECT files FROM usage WHERE user_id = ?1 AND month = ?2').bind(user.id, monthKey()).first();
  const key = await env.DB.prepare('SELECT prefix, created_at FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(user.id).first();
  const used = u ? u.files : 0;
  return page('Dashboard', `
<h1>Your API dashboard</h1><p class="muted">Signed in as ${esc(user.email)}</p>
${newKey ? `<div class="card"><h2 class="ok">Your new API key</h2><p><strong>Copy it now. It will not be shown again.</strong></p><pre>${esc(newKey)}</pre></div>` : ''}
<div class="card"><h2>Usage this month (UTC)</h2><p>${used} of ${quota} files used. Limit: 1 file per minute, 10 MB per file.</p></div>
<div class="card"><h2>API key</h2>
${key ? `<p>Active key: <code>${esc(key.prefix)}…</code> (created ${new Date(key.created_at * 1000).toISOString().slice(0, 10)})</p>` : '<p>You have no active key yet.</p>'}
<form method="post" action="/dashboard/key"><button type="submit">${key ? 'Replace key (old key stops working)' : 'Create API key'}</button></form></div>
<div class="row"><a href="/">How to use the API</a>
<form method="post" action="/logout"><button class="ghost" type="submit">Sign out</button></form></div>`);
}

async function createKey(env, user) {
  const key = 'ept_' + randomToken(32);
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL').bind(t, user.id),
    env.DB.prepare('INSERT INTO api_keys (key_hash, user_id, prefix, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(await sha256(key), user.id, key.slice(0, 10), t),
  ]);
  await audit(env, user.email, 'key_created', null);
  return key;
}

// ---------- public API ----------
async function apiUser(env, req) {
  const auth = req.headers.get('Authorization') || '';
  const key = req.headers.get('X-API-Key') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!key || !key.startsWith('ept_') || key.length > 100) return null;
  return env.DB.prepare(
    'SELECT u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?1 AND k.revoked_at IS NULL'
  ).bind(await sha256(key)).first();
}

async function apiMe(env, req) {
  const user = await apiUser(env, req);
  if (!user) return json({ error: 'invalid_api_key' }, 401);
  if (user.status !== 'active') return json({ error: 'account_blocked' }, 403);
  const quota = user.monthly_quota ?? cfg(env).defaultQuota;
  const u = await env.DB.prepare('SELECT files FROM usage WHERE user_id = ?1 AND month = ?2').bind(user.id, monthKey()).first();
  const used = u ? u.files : 0;
  return json({ email: user.email, month: monthKey(), files_used: used, monthly_quota: quota, files_remaining: Math.max(0, quota - used), max_file_mb: 10 });
}

async function apiCompress(env, req, ctx) {
  const c = cfg(env);
  if (c.paused) return json({ error: 'temporarily_unavailable' }, 503, { 'Retry-After': '3600' });
  const ct = req.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return json({ error: 'use_multipart_form_data', field: 'file' }, 415);
  const len = Number(req.headers.get('Content-Length'));
  if (!len) return json({ error: 'content_length_required' }, 411);
  if (len > MAX_BODY_BYTES) return json({ error: 'file_too_large', max_mb: 10 }, 413);

  const user = await apiUser(env, req);
  if (!user) return json({ error: 'invalid_api_key' }, 401);
  if (user.status !== 'active') return json({ error: 'account_blocked' }, 403);

  const month = monthKey();
  const quota = user.monthly_quota ?? c.defaultQuota;
  const u = await env.DB.prepare('SELECT files FROM usage WHERE user_id = ?1 AND month = ?2').bind(user.id, month).first();
  const used = u ? u.files : 0;
  if (used >= quota) return json({ error: 'monthly_quota_reached', monthly_quota: quota }, 429);
  if ((await counter(env, `files:${month}`)) >= c.globalFiles || (await counter(env, `bytes:${month}`)) >= c.globalBytes) {
    return json({ error: 'service_capacity_reached_this_month' }, 503, { 'Retry-After': '86400' });
  }

  // 1 file per minute: atomic check-and-set
  const t = now();
  const ok = await env.DB.prepare('UPDATE users SET last_call_at = ?1 WHERE id = ?2 AND last_call_at <= ?3')
    .bind(t, user.id, t - RATE_WINDOW).run();
  if (!ok.meta || ok.meta.changes !== 1) {
    const wait = Math.max(1, RATE_WINDOW - (t - user.last_call_at));
    return json({ error: 'rate_limited', retry_after_seconds: wait }, 429, { 'Retry-After': String(wait) });
  }
  const undoRate = () => env.DB.prepare('UPDATE users SET last_call_at = ?1 WHERE id = ?2').bind(user.last_call_at, user.id).run();

  const level = new URL(req.url).searchParams.get('level');
  const target = `${env.BACKEND_URL}/v1/compress${level ? `?level=${encodeURIComponent(level)}` : ''}`;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': ct, 'Content-Length': String(len), 'X-Internal-Secret': env.INTERNAL_SECRET },
      body: req.body,
    });
  } catch (e) {
    console.error('backend_fetch_failed', e && e.name, e && e.message);
    ctx.waitUntil(undoRate());
    return json({ error: 'service_starting_retry_in_60s' }, 503, { 'Retry-After': '60' });
  }

  if (res.status !== 200) {
    console.error('backend_status', res.status, res.headers.get('content-type'), res.headers.get('server'), res.headers.get('x-render-routing'));
    if (res.status >= 500 || res.status === 401) ctx.waitUntil(undoRate());
    if (res.status === 502) ctx.waitUntil(fetch(`${env.BACKEND_URL}/health`).catch(() => {})); // try to wake the backend
    if (res.status === 401) return json({ error: 'service_misconfigured' }, 502);
    const text = await res.text();
    if (res.status >= 500) console.error('backend_body', text.replace(/\s+/g, ' ').slice(0, 400));
    let body; try { body = JSON.parse(text); } catch { body = { error: res.status >= 500 ? 'service_starting_retry_in_60s' : 'upstream_error' }; }
    return json(body, res.status >= 500 ? 503 : res.status, res.status >= 500 ? { 'Retry-After': '60' } : {});
  }

  const outBytes = Number(res.headers.get('X-Compressed-Size')) || 0;
  ctx.waitUntil((async () => {
    await env.DB.prepare(
      'INSERT INTO usage (user_id, month, files, bytes_out) VALUES (?1, ?2, 1, ?3) ' +
      'ON CONFLICT(user_id, month) DO UPDATE SET files = files + 1, bytes_out = bytes_out + excluded.bytes_out'
    ).bind(user.id, month, outBytes).run();
    const exp = t + 40 * 86400;
    await bump(env, `files:${month}`, 1, exp);
    await bump(env, `bytes:${month}`, outBytes, exp);
  })());

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="compressed.pdf"',
    'Cache-Control': 'no-store',
    'X-Quota-Remaining': String(Math.max(0, quota - used - 1)),
  });
  for (const h of ['X-Original-Size', 'X-Compressed-Size', 'X-Compressed', 'X-Level']) {
    const v = res.headers.get(h); if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: 200, headers });
}

// ---------- admin (email-link login, only ADMIN_EMAILS) ----------
const ADMIN_TOKEN_TTL = 10 * 60;      // admin link valid 10 min
const ADMIN_SESSION_TTL = 12 * 3600;  // admin session 12 h
const adminList = (env) => String(env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

async function adminEmail(env, req) {
  const sid = cookie(req, '__Host-adm');
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE sid_hash = ?1 AND expires_at > ?2 AND user_id LIKE 'admin:%'"
  ).bind(await sha256(sid), now()).first();
  if (!row) return null;
  const email = row.user_id.slice(6);
  return adminList(env).includes(email) ? email : null;
}

function adminLoginForm(env, msg = '') {
  return page('Admin sign-in', `<h1>Admin sign-in</h1>
<p>A one-time sign-in link will be sent to the admin email address on file.</p>
${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
<form class="card" method="post" action="/admin/login">
<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY || '')}" style="margin:0 0 12px"></div>
<button type="submit">Send admin sign-in link</button></form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
}

async function adminLogin(env, req) {
  if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
  const form = await req.formData().catch(() => null);
  if (!form || !(await verifyTurnstile(env, req, form.get('cf-turnstile-response')))) return adminLoginForm(env, 'Bot check failed. Please try again.');
  const admins = adminList(env);
  const sent = page('Check the admin inbox', '<h1>Check the admin inbox</h1><p>If sign-in is possible, a link is on its way. It works once and expires in 10 minutes.</p>');
  if (!admins.length) return sent;
  const t = now();
  const hour = Math.floor(t / 3600);
  if ((await bump(env, `adminlink:${hour}`, 1, t + 7200)) > 5) return sent;          // max 5 admin emails per hour
  if ((await counter(env, `emails:${dayKey()}`)) >= cfg(env).emailDailyCap) return sent;
  for (const email of admins) {
    const token = randomToken();
    await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
      .bind(await sha256(token), 'admin:' + email, t + ADMIN_TOKEN_TTL).run();
    const link = `${new URL(req.url).origin}/admin/auth?t=${token}`;
    if (await sendLoginEmail(env, req, email, link, 'admin')) await bump(env, `emails:${dayKey()}`, 1, t + 3 * 86400);
  }
  return sent;
}

async function adminAuth(env, req) {
  const token = new URL(req.url).searchParams.get('t') || '';
  if (req.method === 'GET') {
    return page('Admin sign-in', `<h1>Admin sign-in</h1><form class="card" method="post" action="/admin/auth?t=${esc(encodeURIComponent(token))}">
<p>Click to finish signing in.</p><button type="submit">Continue to admin</button></form>`);
  }
  if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
  const t = now();
  const row = await env.DB.prepare(
    "UPDATE tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 AND user_id LIKE 'admin:%' RETURNING user_id"
  ).bind(t, await sha256(token)).first();
  if (!row || !adminList(env).includes(row.user_id.slice(6))) {
    return page('Link expired', '<h1>This link has expired or was already used</h1><p><a href="/admin">Get a new link</a></p>', 400);
  }
  const sid = randomToken();
  await env.DB.prepare('INSERT INTO sessions (sid_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(sid), row.user_id, t + ADMIN_SESSION_TTL).run();
  await audit(env, row.user_id.slice(6), 'admin_sign_in', null);
  return new Response(null, {
    status: 303,
    headers: { Location: '/admin', 'Set-Cookie': `__Host-adm=${sid}; Path=/; Max-Age=${ADMIN_SESSION_TTL}; HttpOnly; Secure; SameSite=Strict` },
  });
}

async function adminPage(env, req, admin, msg = '') {
  const c = cfg(env);
  const month = monthKey();
  const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const users = await env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.monthly_quota, u.created_at, COALESCE(us.files,0) AS files,
     (SELECT prefix FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL LIMIT 1) AS key_prefix
     FROM users u LEFT JOIN usage us ON us.user_id = u.id AND us.month = ?1
     WHERE (?2 = '' OR u.email LIKE '%' || ?2 || '%') ORDER BY u.created_at DESC LIMIT 200`
  ).bind(month, q).all();
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status").all();
  const logs = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 30').all();
  const files = await counter(env, `files:${month}`);
  const bytes = await counter(env, `bytes:${month}`);
  const emails = await counter(env, `emails:${dayKey()}`);
  const rows = users.results.map((u) => `<tr>
<td>${esc(u.email)}<br><span class="muted">${new Date(u.created_at * 1000).toISOString().slice(0, 10)}</span></td>
<td class="${u.status === 'blocked' ? 'bad' : u.status === 'active' ? 'ok' : ''}">${esc(u.status)}</td>
<td>${u.files} / ${u.monthly_quota ?? c.defaultQuota}</td><td>${u.key_prefix ? `<code>${esc(u.key_prefix)}…</code>` : '-'}</td>
<td><form method="post" action="/admin/action" class="row">
<input type="hidden" name="user_id" value="${esc(u.id)}">
<select name="action"><option value="${u.status === 'blocked' ? 'unblock' : 'block'}">${u.status === 'blocked' ? 'Unblock' : 'Block'}</option>
<option value="quota">Set quota</option><option value="revoke_keys">Revoke key</option></select>
<input name="quota" type="number" min="0" max="100000" placeholder="quota" style="width:90px">
<button type="submit">Apply</button></form></td></tr>`).join('');
  return page('Admin', `<h1>API admin</h1><div class="row"><p class="muted" style="margin:0">Signed in as ${esc(admin)}</p><form method="post" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form></div>
${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
<div class="card"><h2>This month (${month}, UTC)</h2>
<p>Files: ${files} / ${c.globalFiles} global cap · Output: ${(bytes / MB).toFixed(1)} MB / ${(c.globalBytes / MB).toFixed(0)} MB cap · Sign-in emails today: ${emails} / ${c.emailDailyCap}</p>
<p>Users: ${counts.results.map((r) => `${esc(r.status)} ${r.n}`).join(' · ') || '0'} · API ${c.paused ? '<strong class="bad">PAUSED</strong>' : 'running'}</p></div>
<form class="row" method="get" action="/admin"><input name="q" value="${esc(q)}" placeholder="search email"><button class="ghost" type="submit">Search</button></form>
<div class="card" style="overflow:auto"><table><tr><th>User</th><th>Status</th><th>Files this month</th><th>Key</th><th>Action</th></tr>${rows || '<tr><td colspan="5">No users</td></tr>'}</table></div>
<div class="card"><h2>Recent activity</h2><table>${logs.results.map((l) => `<tr><td>${new Date(l.at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td>${esc(l.detail || '')}</td></tr>`).join('')}</table></div>`);
}

async function adminAction(env, req, admin) {
  if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
  const f = await req.formData();
  const id = String(f.get('user_id') || '');
  const action = String(f.get('action') || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!user) return adminPage(env, req, admin, 'User not found');
  const t = now();
  if (action === 'block') {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET status = 'blocked' WHERE id = ?1").bind(id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
    ]);
  } else if (action === 'unblock') {
    await env.DB.prepare("UPDATE users SET status = CASE WHEN verified_at IS NULL THEN 'pending' ELSE 'active' END WHERE id = ?1").bind(id).run();
  } else if (action === 'quota') {
    const qv = parseInt(String(f.get('quota') || ''), 10);
    if (!(qv >= 0 && qv <= 100000)) return adminPage(env, req, admin, 'Enter a quota between 0 and 100000');
    await env.DB.prepare('UPDATE users SET monthly_quota = ?1 WHERE id = ?2').bind(qv, id).run();
  } else if (action === 'revoke_keys') {
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL').bind(t, id).run();
  } else {
    return adminPage(env, req, admin, 'Unknown action');
  }
  await audit(env, admin, action, `${user.email}${action === 'quota' ? ' -> ' + f.get('quota') : ''}`);
  return Response.redirect(new URL('/admin', req.url).toString(), 303);
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      if (!env.INTERNAL_SECRET || !env.BACKEND_URL) return json({ error: 'service_misconfigured' }, 500);

      if (p === '/v1/compress') return m === 'POST' ? apiCompress(env, req, ctx) : json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      if (p === '/v1/me') return m === 'GET' ? apiMe(env, req) : json({ error: 'method_not_allowed' }, 405);
      if (p === '/health') return json({ status: 'ok' });

      if (p === '/admin' || p.startsWith('/admin/')) {
        if (p === '/admin/login' && m === 'POST') return adminLogin(env, req);
        if (p === '/admin/auth') return adminAuth(env, req);
        const admin = await adminEmail(env, req);
        if (!admin) return p === '/admin' && m === 'GET' ? adminLoginForm(env) : page('Forbidden', '<h1>Forbidden</h1>', 403);
        if (p === '/admin' && m === 'GET') return adminPage(env, req, admin);
        if (p === '/admin/action' && m === 'POST') return adminAction(env, req, admin);
        if (p === '/admin/logout' && m === 'POST') {
          if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
          await env.DB.prepare('DELETE FROM sessions WHERE sid_hash = ?1').bind(await sha256(cookie(req, '__Host-adm') || '')).run();
          return new Response(null, { status: 303, headers: { Location: '/admin', 'Set-Cookie': '__Host-adm=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' } });
        }
        return page('Not found', '<h1>Not found</h1>', 404);
      }

      if (p === '/' && m === 'GET') return landing(env);
      if (p === '/signup') return m === 'POST' ? handleSignup(env, req) : signupForm(env);
      if (p === '/auth') return handleAuth(env, req);
      if (p === '/dashboard' && m === 'GET') {
        const user = await currentUser(env, req);
        return user ? dashboard(env, req, user) : Response.redirect(new URL('/signup', req.url).toString(), 303);
      }
      if (p === '/dashboard/key' && m === 'POST') {
        if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
        const user = await currentUser(env, req);
        if (!user) return Response.redirect(new URL('/signup', req.url).toString(), 303);
        return dashboard(env, req, user, await createKey(env, user));
      }
      if (p === '/logout' && m === 'POST') {
        if (!sameOrigin(req)) return page('Error', '<h1>Request blocked</h1>', 403);
        const sid = cookie(req, '__Host-sid');
        if (sid) await env.DB.prepare('DELETE FROM sessions WHERE sid_hash = ?1').bind(await sha256(sid)).run();
        return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': '__Host-sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' } });
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('worker_error', e && e.message);
      return json({ error: 'internal_error' }, 500);
    }
  },

  // Cron: keep the free backend awake and clean old rows.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await fetch(`${env.BACKEND_URL}/health`);
        if (r.status !== 200) console.error('keepwarm_status', r.status, r.headers.get('x-render-routing'));
      } catch (e) { console.error('keepwarm_failed', e && e.message); }
      const t = now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM tokens WHERE expires_at < ?1').bind(t - 86400),
        env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(t),
        env.DB.prepare('DELETE FROM counters WHERE expires_at IS NOT NULL AND expires_at < ?1').bind(t),
      ]);
    })());
  },
};
