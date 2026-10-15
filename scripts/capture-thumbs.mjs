// Captures real thumbnails for games: loads each game through the portal player (sandboxed CDN iframe),
// waits for the first_frame telemetry event + ~3 s, screenshots the game at 1280x720, saves a 640x360 webp,
// uploads it to Storage as `<id>/thumb.webp` and sets games.thumb, only where thumb is empty unless --force.
//
// Usage: npm run thumbs [-- --force] [--ids a,b] [--all] [--out seed/thumbs] [--settle 3000]
//   default   the seed games (seed/games.json)
//   --all     every game in the DB
//   --ids     comma-separated game ids/slugs
//   --out     also write <id>.webp into this directory (used to refresh the committed seed thumbnails)
//   --force   overwrite existing thumbs
// Connection: the LOCAL Supabase stack from `supabase status` (npm run db:start). Non-loopback Supabase/DB URLs
// are refused unless --allow-remote is passed explicitly.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from './lib/local-supabase.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const force = flag('force');
const settleMs = Number(opt('settle') ?? 3000);
const outDir = opt('out');

const LOOPBACK = /^(https?|postgres(ql)?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const sb = process.env.PUBLIC_SUPABASE_URL && process.env.DATABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? { PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL, DATABASE_URL: process.env.DATABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY, PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY }
  : localSupabaseEnv();
for (const [k, v] of [['PUBLIC_SUPABASE_URL', sb.PUBLIC_SUPABASE_URL], ['DATABASE_URL', sb.DATABASE_URL]]) {
  if (!LOOPBACK.test(v ?? '') && !flag('allow-remote')) {
    console.error(`[thumbs] refusing non-local ${k} (${String(v).replace(/\/\/[^@]*@/, '//***@')}). Pass --allow-remote to override.`);
    process.exit(2);
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

const sql = postgres(sb.DATABASE_URL, { prepare: false, onnotice: () => {} });
const bucket = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');

const ids = opt('ids')?.split(',').map((s) => s.trim()).filter(Boolean)
  ?? (flag('all') ? null : JSON.parse(fs.readFileSync('seed/games.json', 'utf8')).map((g) => g.id));
const games = await sql`
  select id, slug, title, thumb from games
  ${ids ? sql`where id in ${sql(ids)} or slug in ${sql(ids)}` : sql``}
  order by created_at`;
const todo = games.filter((g) => force || !g.thumb);
for (const g of games) if (!todo.includes(g)) console.log(`[thumbs] skip ${g.id} (${g.title}): already has ${g.thumb}`);
if (ids) for (const id of ids) if (!games.some((g) => g.id === id || g.slug === id)) console.log(`[thumbs] not found: ${id}`);
if (!todo.length) {
  console.log(`[thumbs] nothing to do (${games.length} checked${force ? '' : '; use --force to overwrite'})`);
  await sql.end();
  process.exit(0);
}

if (!fs.existsSync('dist/server/entry.mjs') || flag('build')) {
  console.log('[thumbs] building portal…');
  execFileSync('npx', ['astro', 'build'], { stdio: ['ignore', 'ignore', 'inherit'], env });
}
const procs = [];
const stop = () => procs.forEach((p) => p.exitCode === null && p.kill('SIGTERM'));
process.on('exit', stop);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(130); });
for (const [name, file] of [['game-cdn', 'scripts/game-cdn.mjs'], ['portal', 'dist/server/entry.mjs']]) {
  const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => !/ExperimentalWarning|trace-warnings/.test(d) && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
}
for (let i = 0; ; i++) {
  try { if ((await fetch(`${WEB}/login`)).ok && (await fetch(`${CDN}/`)).status) break; } catch {}
  if (i > 120) throw new Error('servers did not start');
  await new Promise((r) => setTimeout(r, 250));
}

if (outDir) fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
try {
  for (const g of todo) {
    const t0 = Date.now();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      const firstFrame = page.waitForRequest(
        (r) => r.url().endsWith('/api/telemetry') && r.postDataJSON()?.type === 'first_frame' && r.postDataJSON()?.gameId === g.id,
        { timeout: 20_000 },
      );
      await page.goto(`${WEB}/play/${g.slug}`);
      await page.locator('.launch').click();
      // Pin the game frame to exactly 1280x720 at the top-left so the screenshot is the game only.
      await page.locator('iframe.mg-frame').evaluate((f) => {
        Object.assign(f.style, { position: 'fixed', inset: '0 auto auto 0', width: '1280px', height: '720px', zIndex: '2147483647', border: '0', borderRadius: '0' });
      });
      await firstFrame;
      await page.waitForTimeout(settleMs);
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 720 } });
      const webp = await sharp(png).resize(640, 360).webp({ quality: 82 }).toBuffer();
      if (outDir) fs.writeFileSync(path.join(outDir, `${g.id}.webp`), webp);
      const { error } = await bucket.upload(`${g.id}/thumb.webp`, webp, { contentType: 'image/webp', upsert: true });
      if (error) throw error;
      const [row] = await sql`
        update games set thumb = 'thumb.webp'
        where id = ${g.id} ${force ? sql`` : sql`and (thumb is null or thumb = '')`}
        returning id`;
      console.log(`[thumbs] ${row ? (g.thumb ? 'overwrote' : 'set') : 'raced'} ${g.id} (${g.title}): 640x360 webp ${(webp.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms${outDir ? ` -> ${outDir}/${g.id}.webp` : ''}`);
    } catch (e) {
      failed++;
      console.error(`[thumbs] FAILED ${g.id} (${g.title}): ${e.message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  stop();
  await sql.end();
}
console.log(`[thumbs] done: ${todo.length - failed} captured, ${games.length - todo.length} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
