// Browse -> play a seed game like a visitor, prove the sandboxed CDN iframe booted, capture evidence.
// Usage (via vmg.sh so ports/env are ours):  vmg.sh exec -- node .cursor/skills/verify-meshgrounds/scripts/drive-play.mjs <outDir> [gameId=stk7wr01] [title="Stack Tower"]
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import postgres from 'postgres';

const [out, id = 'stk7wr01', title = 'Stack Tower'] = process.argv.slice(2);
if (!out) { console.error('usage: drive-play.mjs <outDir> [gameId] [title]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const WEB = process.env.SITE_URL, CDN = process.env.MG_CDN_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(WEB ?? '')) throw new Error('SITE_URL must be a 127.0.0.1 origin (run through vmg.sh exec)');
const log = [];
if (!/@127\.0\.0\.1:\d+\//.test(process.env.DATABASE_URL ?? '')) throw new Error('DATABASE_URL must be 127.0.0.1');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const sessions = async () => (await sql`select count(*)::int n from public.sessions where game_id = ${id}`)[0].n;
const before = await sessions();
const step = (msg) => { log.push(msg); console.log(msg); };
const browser = await chromium.launch({ args: ['--disable-site-isolation-trials'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const telemetry = [];
page.on('response', (r) => { if (r.url().endsWith('/api/telemetry')) telemetry.push(`${r.status()} ${r.request().postDataJSON()?.type}`); });
let fail = 0;
const check = (ok, msg) => { step(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
try {
  await page.goto(`${WEB}/games`);
  check((await page.getByRole('link', { name: new RegExp(title) }).count()) > 0, `/games lists "${title}"`);
  await page.screenshot({ path: `${out}/01-games.png` });
  await page.goto(`${WEB}/play/${id}`);
  check(new URL(page.url()).pathname.startsWith('/play/') && !page.url().endsWith(id), `/play/${id} redirected to slug ${new URL(page.url()).pathname}`);
  await page.screenshot({ path: `${out}/02-play-before.png` });
  await page.getByRole('button', { name: `Play ${title}` }).click();
  const frameEl = page.locator('iframe.mg-frame');
  await frameEl.waitFor();
  const sandbox = await frameEl.getAttribute('sandbox');
  const src = await frameEl.getAttribute('src');
  check(sandbox === 'allow-scripts allow-pointer-lock', `iframe sandbox="${sandbox}"`);
  check(src?.startsWith(`${CDN}/g/${id}/index.html`), `iframe src on CDN origin: ${src?.split('#')[0]}`);
  await page.frameLocator('iframe.mg-frame').locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
  check(true, 'canvas visible inside the game frame');
  const hasMg = await page.frames().find((f) => f.url().startsWith(CDN))?.evaluate(() => typeof window.Meshground);
  check(hasMg === 'object', `window.Meshground inside frame: ${hasMg}`);
  await page.waitForTimeout(2000);
  check(telemetry.some((t) => t === '204 session_start'), `telemetry: ${telemetry.join(', ')}`);
  const after = await sessions();
  check(after > before, `DB public.sessions rows for ${id}: ${before} -> ${after}`);
  await page.screenshot({ path: `${out}/03-playing.png` });
  fs.writeFileSync(`${out}/03-playing.aria.txt`, await page.locator('main').first().ariaSnapshot());
} catch (e) { check(false, `error: ${e.message}`); }
await browser.close();
await sql.end();
fs.writeFileSync(`${out}/drive-play.log`, log.join('\n') + `\nresult: ${fail ? 'FAIL' : 'PASS'}\n`);
console.log(fail ? `FAIL (${fail})` : 'PASS'); process.exit(fail ? 1 : 0);
