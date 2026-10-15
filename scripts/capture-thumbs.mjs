// Captures real thumbnails for games: loads each game through the portal player (sandboxed CDN iframe),
// waits for the game's first frame + a settle delay, screenshots it at 1280x720 and saves a 640x360 webp.
// Every image is checked for blank / near-single-colour frames (retried once after an input and a further
// delay, then skipped and reported) and run through the portal's real validateThumb before anything is stored.
// It is uploaded to a NEW versioned key `<id>/thumb-<version>.webp` (never upserted), and only after the upload
// succeeds is games.thumb switched to it, compare-and-set against the value read at the start.
//
// Usage: npm run thumbs [-- --dry-run] [--force] [--ids a,b] [--all] [--out dir] [--settle 3000] [--retry-settle 3000]
//   default    the seed games (seed/games.json)
//   --all      every game in the DB         --ids  comma-separated game ids/slugs
//   --out      also write <id>.webp here (used to refresh the committed seed thumbnails)
//   --force    overwrite existing thumbs (with --all it also needs --yes)
//   --dry-run  capture + validate to a local directory (--out, else a temp dir) and report what would be uploaded
//              and updated; writes nothing to Storage or the DB
// Telemetry: every /api/telemetry request from the capture browser is intercepted and aborted, so captures
// never create session rows. The first_frame event is read from the intercepted request.
// Connection: with none of PUBLIC_SUPABASE_URL / DATABASE_URL / SUPABASE_SECRET_KEY set, the LOCAL stack from
// `supabase status`. If any is set, PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY are required (no fallback).
//   DATABASE_URL set      direct Postgres for the games table (needs port 5432/6543)
//   DATABASE_URL absent   REST mode (also forced with --rest): every read and the conditional update go through
//                         supabase-js/PostgREST over HTTPS; Storage is HTTPS in both modes. REST mode captures
//                         through a minimal local player page (same sandboxed CDN iframe) instead of the portal,
//                         which itself needs Postgres.
// A non-loopback target needs --allow-remote AND typing the project ref at the prompt (or --yes).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import postgres from 'postgres';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from './lib/local-supabase.mjs';
import { blankVerdict, parseArgs, resolveTarget, thumbKey } from './lib/thumbs.mjs';
import { pgStore, restStore } from './lib/thumb-store.mjs';
import http from 'node:http';
import { validateThumb } from '../src/lib/server/upload.ts';

const log = (...a) => console.log('[thumbs]', ...a);
const die = (msg, code = 2) => { console.error(`[thumbs] ${msg}`); process.exit(code); };

const args = parseArgs(process.argv.slice(2));
const target = resolveTarget(process.env, args);
if (target.error) die(target.error);
let sb;
if (target.mode === 'local') sb = localSupabaseEnv();
else sb = target.env;
if (target.db === 'rest') delete sb.DATABASE_URL; // REST mode never opens a Postgres connection
log(`games table via ${target.db === 'rest' ? `REST (PostgREST over ${new URL(sb.PUBLIC_SUPABASE_URL).protocol.replace(':', '')})` : 'direct Postgres'}`);
if (target.mode === 'remote') {
  log(`REMOTE target: project ${target.ref}${args.dryRun ? ' (dry run: read-only)' : ''}`);
  if (target.needConfirm) {
    if (!process.stdin.isTTY) die('remote run needs confirmation: type the project ref interactively or pass --yes.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`Type the project ref (${target.ref}) to continue: `)).trim();
    rl.close();
    if (typed !== target.ref) die('confirmation did not match; aborting.');
  }
}

const WEB_PORT = Number(process.env.THUMBS_WEB_PORT ?? 4931);
const CDN_PORT = Number(process.env.THUMBS_CDN_PORT ?? 4932);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
const env = {
  ...process.env, ...sb, HOST: '127.0.0.1', PORT: String(WEB_PORT), SITE_URL: WEB,
  MG_CDN_PORT: String(CDN_PORT), MG_CDN_ORIGIN: CDN, MG_WEB_ORIGINS: `${WEB} http://localhost:${WEB_PORT}`,
};

const client = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const bucket = client.storage.from('games');
const store = target.db === 'rest' ? restStore(client) : pgStore(postgres(sb.DATABASE_URL, { prepare: false, onnotice: () => {} }));

const ids = args.ids ?? (args.all ? null : JSON.parse(fs.readFileSync('seed/games.json', 'utf8')).map((g) => g.id));
const games = await store.list(ids);
const todo = games.filter((g) => args.force || !g.thumb);
for (const g of games) if (!todo.includes(g)) log(`skip ${g.id} (${g.title}): already has ${g.thumb}`);
if (ids) for (const id of ids) if (!games.some((g) => g.id === id || g.slug === id)) log(`not found: ${id}`);
if (!todo.length) {
  log(`nothing to do (${games.length} checked${args.force ? '' : '; use --force to overwrite'})`);
  await store.end();
  process.exit(0);
}
const outDir = args.out ?? (args.dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'mg-thumbs-dry-')) : undefined);
if (outDir) fs.mkdirSync(outDir, { recursive: true });
if (args.dryRun) log(`DRY RUN: captures go to ${outDir}; no Storage uploads, no DB writes`);

const usePortal = target.db === 'pg';
if (usePortal && (!fs.existsSync('dist/server/entry.mjs') || args.build)) {
  log('building portal…');
  execFileSync('npx', ['astro', 'build'], { stdio: ['ignore', 'ignore', 'inherit'], env });
}
const procs = [];
let harness;
const stop = () => { procs.forEach((p) => p.exitCode === null && p.kill('SIGTERM')); harness?.close(); };
process.on('exit', stop);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(130); });
if (!usePortal) {
  // Minimal player page on the "portal" origin: the same sandboxed, opaque-origin CDN iframe the portal uses,
  // pinned to 1280x720. It has no telemetry at all; it only records the game's first-frame message.
  harness = http.createServer((req, res) => {
    const u = new URL(req.url, WEB);
    if (u.pathname === '/login') return res.end('ok');
    const id = u.pathname.match(/^\/capture\/([A-Za-z0-9_-]{6,16})$/)?.[1];
    if (!id) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body style="margin:0;background:#000">
<iframe class="mg-frame" sandbox="allow-scripts allow-pointer-lock" allow="autoplay; gamepad" referrerpolicy="no-referrer"
  style="position:fixed;inset:0 auto auto 0;width:1280px;height:720px;border:0"
  src="${CDN}/g/${id}/index.html?embed=${encodeURIComponent(WEB)}#mgs=%7B%7D"></iframe>
<script>addEventListener('message', (e) => { if (e.data && e.data.type === '__MG_FIRST_FRAME') window.__mgFirstFrame = true; });</script>
</body></html>`);
  }).listen(WEB_PORT, '127.0.0.1');
}
for (const [name, file] of usePortal ? [['game-cdn', 'scripts/game-cdn.mjs'], ['portal', 'dist/server/entry.mjs']] : [['game-cdn', 'scripts/game-cdn.mjs']]) {
  const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => !/ExperimentalWarning|trace-warnings/.test(d) && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
}
for (let i = 0; ; i++) {
  try { if ((await fetch(`${WEB}/login`)).ok && (await fetch(`${CDN}/`)).status) break; } catch {}
  if (i > 120) throw new Error('servers did not start');
  await new Promise((r) => setTimeout(r, 250));
}

async function shoot(page) {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } });
  const img = sharp(png).resize(640, 360);
  const verdict = blankVerdict(await img.clone().stats());
  return { webp: await img.webp({ quality: 82 }).toBuffer(), ...verdict };
}

const browser = await chromium.launch();
const result = { captured: [], blank: [], failed: [], raced: [] };
let telemetryBlocked = 0;
try {
  for (const g of todo) {
    const t0 = Date.now();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      let onFirstFrame;
      const firstFrame = new Promise((resolve, reject) => {
        onFirstFrame = resolve;
        setTimeout(() => reject(new Error('no first_frame within 20 s')), 20_000).unref();
      });
      firstFrame.catch(() => {});
      // Telemetry off: abort every telemetry request (fetch and sendBeacon) before it reaches the portal.
      await context.route('**/api/telemetry*', (route) => {
        telemetryBlocked++;
        let body = null;
        try { body = route.request().postDataJSON(); } catch {}
        if (body?.type === 'first_frame' && body?.gameId === g.id) onFirstFrame();
        return route.abort();
      });
      if (usePortal) {
        await page.goto(`${WEB}/play/${g.slug}`);
        await page.locator('.launch').click();
        // Pin the game frame to exactly 1280x720 at the top-left so the screenshot is the game only.
        await page.locator('iframe.mg-frame').evaluate((f) => {
          Object.assign(f.style, { position: 'fixed', inset: '0 auto auto 0', width: '1280px', height: '720px', zIndex: '2147483647', border: '0', borderRadius: '0' });
        });
        await firstFrame;
      } else {
        await page.goto(`${WEB}/capture/${g.id}`);
        await page.waitForFunction(() => window.__mgFirstFrame === true, null, { timeout: 20_000 });
      }
      await page.waitForTimeout(args.settleMs);
      let shot = await shoot(page);
      if (shot.blank) {
        log(`${g.id}: frame looks blank (stdev ${shot.stdev}); sending input and retrying in ${args.retryMs} ms`);
        await page.mouse.click(640, 360);
        await page.keyboard.press('Space');
        await page.waitForTimeout(args.retryMs);
        shot = await shoot(page);
      }
      if (shot.blank) {
        result.blank.push(g);
        console.error(`[thumbs] SKIPPED ${g.id} (${g.title}): blank / single-colour frame after retry (stdev ${shot.stdev})`);
        continue;
      }
      const checked = await validateThumb(new File([shot.webp], 'thumb.webp', { type: 'image/webp' }));
      if ('error' in checked) throw new Error(`validateThumb rejected capture: ${checked.error}`);
      const key = thumbKey();
      const kb = (shot.webp.length / 1024).toFixed(1);
      if (outDir) fs.writeFileSync(path.join(outDir, `${g.id}.webp`), shot.webp);
      if (args.dryRun) {
        result.captured.push(g);
        log(`would upload ${g.id}/${key} (640x360 webp ${kb} KB, stdev ${shot.stdev}, validateThumb ok) and set games.thumb ${g.thumb ?? 'null'} -> ${key}; saved ${outDir}/${g.id}.webp`);
        continue;
      }
      const { error } = await bucket.upload(`${g.id}/${key}`, shot.webp, { contentType: 'image/webp', upsert: false });
      if (error) throw new Error(`upload failed, DB untouched: ${error.message}`);
      // Compare-and-set, only after the upload succeeded (pg: `is not distinct from`; REST: eq/is filter).
      const won = await store.setThumb(g.id, g.thumb, key);
      if (!won) {
        await bucket.remove([`${g.id}/${key}`]);
        result.raced.push(g);
        console.error(`[thumbs] RACED ${g.id} (${g.title}): thumb changed during capture; kept the other value, removed ${key}`);
        continue;
      }
      // The superseded versioned object is no longer referenced by any row.
      if (g.thumb?.startsWith('thumb-')) await bucket.remove([`${g.id}/${g.thumb}`]);
      result.captured.push(g);
      log(`${g.thumb ? 'overwrote' : 'set'} ${g.id} (${g.title}): ${key} 640x360 webp ${kb} KB (stdev ${shot.stdev}) in ${Date.now() - t0} ms${outDir ? ` -> ${outDir}/${g.id}.webp` : ''}`);
    } catch (e) {
      result.failed.push(g);
      console.error(`[thumbs] FAILED ${g.id} (${g.title}): ${e.message}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  stop();
  await store.end();
}
const names = (l) => (l.length ? ` [${l.map((g) => g.id).join(', ')}]` : '');
log(`done${args.dryRun ? ' (dry run, nothing written)' : ''}: ${result.captured.length} ${args.dryRun ? 'would be uploaded' : 'captured'}, ` +
  `${games.length - todo.length} already had thumbs, ${result.blank.length} blank-skipped${names(result.blank)}, ` +
  `${result.raced.length} raced${names(result.raced)}, ${result.failed.length} failed${names(result.failed)}; ${telemetryBlocked} telemetry requests blocked`);
// 1 = failures, 3 = finished but some games were skipped as blank.
process.exit(result.failed.length ? 1 : result.blank.length ? 3 : 0);
