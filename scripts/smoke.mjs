// Smoke test against the LOCAL Supabase stack (`npm run db:start` first).
// Builds (unless SMOKE_SKIP_BUILD=1), seeds demo games, starts the portal + game CDN on dedicated ports,
// then checks every page, auth route, save route and API route for an exact status. Nonzero exit on any miss.
// Supabase keys come from `supabase status` at runtime only and are never written to disk.
//
// Exact non-200 statuses that are expected (they are the routes' designed behaviour, not failures):
//   - POST /api/telemetry          -> 204  (fire-and-forget beacon, no body)
//   - POST /api/games (upload)     -> 303  (redirect to the new game's /play page)
//   - GET  /play/<id>              -> 301  (canonical redirect to /play/<slug>, which must be 200)
//   - POST /api/auth/*, /api/profile, /api/games/<slug>/delete -> 303 (form posts redirect back to a page)
//   - POST /api/saves/<gameId>     -> 204  (save stored, no body)
//   - /u/<handle> for a creator with no games -> 404 (page rewrites to /404)
//   - protected pages (/me, /onboarding) when signed out -> 302 to /login; API routes when signed out -> 401
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { localSupabaseEnv } from './lib/local-supabase.mjs';
import { findMoneyClaims, findPaymentPromises } from '../src/lib/money-claims.ts';

const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 4621);
const CDN_PORT = Number(process.env.SMOKE_CDN_PORT ?? 4622);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
const sb = localSupabaseEnv();
const env = {
  ...process.env,
  ...sb,
  HOST: '127.0.0.1',
  PORT: String(WEB_PORT),
  SITE_URL: WEB,
  MG_CDN_PORT: String(CDN_PORT),
  MG_CDN_ORIGIN: CDN,
  MG_WEB_ORIGINS: `${WEB} http://localhost:${WEB_PORT}`,
};

if (process.env.SMOKE_SKIP_BUILD !== '1' || !fs.existsSync('dist/server/entry.mjs')) {
  console.log('[smoke] building…');
  execFileSync('npx', ['astro', 'build'], { stdio: ['ignore', 'ignore', 'inherit'], env });
}
console.log('[smoke] seeding local Supabase…');
execFileSync(process.execPath, ['scripts/seed.mjs'], { stdio: ['ignore', 'ignore', 'inherit'], env });

const procs = [];
const start = (name, args) => {
  const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => !/ExperimentalWarning|trace-warnings/.test(d) && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  console.log(`[smoke] started ${name} pid=${p.pid}`);
};
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  for (const p of procs) if (p.exitCode === null) { try { p.kill('SIGTERM'); } catch {} }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// Minimal cookie jar so auth flows behave like a browser session.
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function storeCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1);
    if (!value || attrs.some((a) => /max-age=0\b/i.test(a) || /expires=thu, 01 jan 1970/i.test(a))) jar.delete(name);
    else jar.set(name, value);
  }
}

let failed = 0, total = 0;
async function check(label, url, want, { method = 'GET', body, json, form, auth = true, verify } = {}) {
  total++;
  const headers = { Origin: WEB };
  if (auth && jar.size) headers.Cookie = cookieHeader();
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.set(k, v); }
  let res, got, note = '';
  try {
    res = await fetch(url, { method, headers, body, redirect: 'manual' });
    if (auth) storeCookies(res);
    got = res.status;
    if (got === want && verify) note = (await verify(res)) || '';
  } catch (e) { got = `ERR ${e.message}`; }
  const ok = got === want && !note.startsWith('!');
  if (!ok) failed++;
  const loc = res?.headers.get('location');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${String(got).padEnd(3)} (want ${want}) ${method.padEnd(4)} ${label}${loc ? ` -> ${loc.replace(WEB, '')}` : ''}${note ? `  ${note}` : ''}`);
  return res;
}
const expectLoc = (re) => (r) => (re.test(r.headers.get('location') ?? '') ? '' : `! unexpected location`);

const seed = JSON.parse(fs.readFileSync('seed/games.json', 'utf8'));
const game = seed[0];
const email = `smoke-${Date.now()}@example.test`;
const password = 'smoke-pass-123';
const handle = `smoke${Date.now().toString(36)}`;

try {
  start('game-cdn', ['scripts/game-cdn.mjs']);
  start('portal', ['dist/server/entry.mjs']);
  await Promise.all([waitFor(`${WEB}/login`), waitFor(`${CDN}/g/${game.id}/index.html`)]);
  console.log('[smoke] servers ready\n--- public pages');
  for (const p of ['/', '/games', '/creators', '/proving', '/login', '/EXCHANGE_SDK.md', '/favicon.svg']) await check(p, WEB + p, 200, { auth: false });
  // PAY-1: no specific creator revenue numbers (percent / $ near revenue, payout, royalty) on the rendered pages.
  for (const p of ['/', '/creators']) await check(`${p} (no revenue numbers or payment promises)`, WEB + p, 200, { auth: false, verify: async (r) => { const html = await r.text(); const hits = [...findMoneyClaims(html), ...findPaymentPromises(html)]; return hits.length ? `! ${JSON.stringify(hits)}` : ''; } });
  for (const g of seed) {
    const r = await check(`/play/${g.id}`, `${WEB}/play/${g.id}`, 301, { auth: false });
    const slugPath = new URL(r?.headers.get('location') ?? `/play/${g.id}`, WEB).pathname;
    await check(slugPath, WEB + slugPath, 200, { auth: false });
  }
  for (const c of new Set(seed.map((g) => g.creator))) await check(`/u/${c}`, `${WEB}/u/${c}`, 200, { auth: false });

  console.log('--- signed-out guards');
  await check('/me', `${WEB}/me`, 302, { auth: false, verify: expectLoc(/^\/login/) });
  await check('/onboarding', `${WEB}/onboarding`, 302, { auth: false, verify: expectLoc(/^\/login/) });
  await check('/upload', `${WEB}/upload`, 302, { auth: false, verify: expectLoc(/^\/login/) });
  await check(`/api/saves/${game.id}`, `${WEB}/api/saves/${game.id}`, 401, { auth: false });
  await check(`/api/games/${game.id}/rate`, `${WEB}/api/games/${game.id}/rate`, 401, { method: 'POST', json: { stars: 5 }, auth: false });

  console.log('--- auth');
  await check('/api/auth/login (signup)', `${WEB}/api/auth/login`, 303, { method: 'POST', form: { mode: 'signup', email, password, next: '/' }, verify: expectLoc(/^\/onboarding/) });
  await check('/onboarding (signed in, no handle)', `${WEB}/onboarding`, 200);
  await check('/me (no handle -> onboarding)', `${WEB}/me`, 302, { verify: expectLoc(/^\/onboarding/) });
  await check('/api/profile (pick handle)', `${WEB}/api/profile`, 303, { method: 'POST', form: { handle, next: '/me' }, verify: expectLoc(/^\/me$/) });
  await check('/me', `${WEB}/me`, 200);
  await check('/upload', `${WEB}/upload`, 200);
  await check(`/u/${handle} (no games yet)`, `${WEB}/u/${handle}`, 404);
  await check('/api/auth/logout', `${WEB}/api/auth/logout`, 303, { method: 'POST', verify: expectLoc(/^\/$/) });
  await check('/me (after logout)', `${WEB}/me`, 302, { verify: expectLoc(/^\/login/) });
  await check('/api/auth/login (bad password)', `${WEB}/api/auth/login`, 303, { method: 'POST', form: { mode: 'password', email, password: 'wrong-password', next: '/me' }, verify: expectLoc(/^\/login\?.*error=/) });
  await check('/api/auth/login (magic link)', `${WEB}/api/auth/login`, 303, { method: 'POST', auth: false, form: { mode: 'magic', email, next: '/' }, verify: expectLoc(/sent=magic/) });
  await check('/auth/callback (no code)', `${WEB}/auth/callback`, 303, { auth: false, verify: expectLoc(/^\/login\?.*error=/) });
  await check('/api/auth/login (sign in)', `${WEB}/api/auth/login`, 303, { method: 'POST', form: { mode: 'password', email, password, next: '/me' }, verify: expectLoc(/^\/me$/) });
  await check('/me (signed in)', `${WEB}/me`, 200);

  console.log('--- saves');
  const items = { best: '42', smoke: email };
  await check(`/api/saves/${game.id} (read, empty)`, `${WEB}/api/saves/${game.id}`, 200, { verify: async (r) => ((await r.json()).data === null ? 'data=null' : '! expected null') });
  await check(`/api/saves/${game.id} (create)`, `${WEB}/api/saves/${game.id}`, 204, { method: 'POST', json: { items } });
  await check(`/api/saves/${game.id} (read back)`, `${WEB}/api/saves/${game.id}`, 200, { verify: async (r) => (JSON.stringify((await r.json()).data) === JSON.stringify(items) ? 'data matches' : '! data mismatch') });
  await check(`/api/saves/${game.id} (overwrite with {})`, `${WEB}/api/saves/${game.id}`, 204, { method: 'POST', json: { items: {} } });
  await check(`/api/saves/${game.id} (read cleared)`, `${WEB}/api/saves/${game.id}`, 200, { verify: async (r) => (JSON.stringify((await r.json()).data) === '{}' ? 'data={}' : '! not cleared') });
  await check(`/api/saves/${game.id} (invalid)`, `${WEB}/api/saves/${game.id}`, 400, { method: 'POST', json: { items: { n: 1 } } });
  await check('/api/saves/nosuchgame (create)', `${WEB}/api/saves/nosuchgame`, 404, { method: 'POST', json: { items } });

  console.log('--- game APIs');
  await check(`/api/games/${game.id}/rate`, `${WEB}/api/games/${game.id}/rate`, 200, { method: 'POST', json: { stars: 5 } });
  await check('/api/telemetry', `${WEB}/api/telemetry`, 204, { method: 'POST', auth: false, json: { sessionId: crypto.randomUUID(), gameId: game.id, type: 'session_start' } });
  const html = new File(['<!doctype html><html><body><canvas></canvas><script>1</script></body></html>'], 'g.html', { type: 'text/html' });
  const up = await check('/api/games (upload)', `${WEB}/api/games`, 303, { method: 'POST', form: { title: 'Smoke Game', license: 'MIT', agree: 'on', game: html }, verify: expectLoc(/^\/play\//) });
  const newPath = new URL(up?.headers.get('location') ?? '/play/none', WEB).pathname;
  const slug = newPath.split('/')[2];
  await check(newPath, WEB + newPath, 200);
  await check(`/u/${handle} (has a game)`, `${WEB}/u/${handle}`, 200);
  await check(`/api/games/${slug}/delete`, `${WEB}/api/games/${slug}/delete`, 303, { method: 'POST', verify: expectLoc(/^\/me\?deleted=1/) });
  await check(`${newPath} (after delete)`, WEB + newPath, 404);
  await check('/api/auth/logout', `${WEB}/api/auth/logout`, 303, { method: 'POST' });

  console.log('--- game CDN');
  for (const g of seed) await check(`${CDN}/g/${g.id}/index.html`, `${CDN}/g/${g.id}/index.html`, 200, { auth: false });
  await check(`${CDN}/g/${game.id}/index.html?source`, `${CDN}/g/${game.id}/index.html?source`, 200, { auth: false });
} catch (e) {
  console.error(`[smoke] ${e.message}`);
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `[smoke] FAILED: ${failed} of ${total} check(s)` : `[smoke] OK: ${total} checks passed`);
process.exit(failed ? 1 : 0);
