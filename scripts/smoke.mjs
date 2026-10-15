// Smoke test: builds (unless SMOKE_SKIP_BUILD=1), starts the portal + game CDN on dedicated ports
// against a throwaway data dir, curls every page and API route, and exits nonzero on any unexpected status.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 4621);
const CDN_PORT = Number(process.env.SMOKE_CDN_PORT ?? 4622);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-smoke-'));
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(WEB_PORT),
  MG_CDN_PORT: String(CDN_PORT),
  MG_CDN_ORIGIN: CDN,
  MG_WEB_ORIGINS: `${WEB} http://localhost:${WEB_PORT}`,
  MG_DATA_DIR: dataDir,
};

if (process.env.SMOKE_SKIP_BUILD !== '1' || !fs.existsSync('dist/server/entry.mjs')) {
  console.log('[smoke] building…');
  execFileSync('npx', ['astro', 'build'], { stdio: ['ignore', 'ignore', 'inherit'], env });
}

const procs = [];
const start = (name, args) => {
  const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  console.log(`[smoke] started ${name} pid=${p.pid}`);
  return p;
};
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  for (const p of procs) if (p.exitCode === null) { try { p.kill('SIGTERM'); } catch {} }
  fs.rmSync(dataDir, { recursive: true, force: true });
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

const seed = JSON.parse(fs.readFileSync('seed/games.json', 'utf8'));
const game = seed[0];
const json = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

function uploadForm() {
  const f = new FormData();
  f.set('title', 'Smoke Game');
  f.set('creator', 'smoketest');
  f.set('license', 'MIT');
  f.set('agree', 'on');
  f.set('game', new File(['<!doctype html><html><body><canvas></canvas><script>1</script></body></html>'], 'g.html', { type: 'text/html' }));
  return { method: 'POST', body: f, redirect: 'manual', headers: { Origin: WEB } };
}

const checks = [
  // pages
  ['GET', `${WEB}/`, 200],
  ['GET', `${WEB}/games`, 200],
  ['GET', `${WEB}/creators`, 200],
  ['GET', `${WEB}/proving`, 200],
  ['GET', `${WEB}/upload`, 200],
  ['GET', `${WEB}/EXCHANGE_SDK.md`, 200],
  ['GET', `${WEB}/favicon.svg`, 200],
  // /play/<id> 301-redirects to the canonical /play/<slug>; check both
  ...seed.map((g) => ['GET', `${WEB}/play/${g.id}`, 301]),
  ...seed.map((g) => ['GET', () => slugUrl(g.id), 200]),
  ...[...new Set(seed.map((g) => g.creator))].map((c) => ['GET', `${WEB}/u/${c}`, 200]),
  // API routes
  ['POST /api/games/[slug]/rate', `${WEB}/api/games/${game.id}/rate`, 200, () => json({ stars: 5 })],
  ['POST /api/telemetry', `${WEB}/api/telemetry`, 204, () => json({ sessionId: crypto.randomUUID(), gameId: game.id, type: 'session_start' })],
  ['POST /api/games (upload)', `${WEB}/api/games`, 303, uploadForm],
  // CDN origin
  ...seed.map((g) => ['GET', `${CDN}/g/${g.id}/index.html`, 200]),
  ['GET', `${CDN}/g/${game.id}/index.html?source`, 200],
];

const slugUrl = async (id) => new URL((await fetch(`${WEB}/play/${id}`, { redirect: 'manual' })).headers.get('location') ?? `/play/${id}`, WEB).href;

let failed = 0;
try {
  start('game-cdn', ['scripts/game-cdn.mjs']);
  start('portal', ['dist/server/entry.mjs']);
  await Promise.all([waitFor(`${WEB}/`), waitFor(`${CDN}/g/${game.id}/index.html`)]);
  console.log('[smoke] servers ready');
  for (let [label, url, want, init] of checks) {
    if (typeof url === 'function') url = await url();
    let got;
    try { got = (await fetch(url, init ? init() : { redirect: 'manual' })).status; } catch (e) { got = `ERR ${e.message}`; }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${String(got).padEnd(3)} (want ${want}) ${label.startsWith('POST') ? label : `GET ${url}`}`);
  }
} catch (e) {
  console.error(`[smoke] ${e.message}`);
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `[smoke] FAILED: ${failed} check(s)` : `[smoke] OK: ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
