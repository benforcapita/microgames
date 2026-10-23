import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';
import { shotPath, SHOT_DIR } from './shots.mjs';

const env = localSupabaseEnv();
if (!['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname)) throw new Error('local Supabase only');
const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
const sha = 'cd'.repeat(32);

async function asOwner(tx, ownerId) {
  await tx`select set_config('request.jwt.claim.sub', ${ownerId}, true)`;
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ownerId, role: 'authenticated' })}, true)`;
  await tx.unsafe('set local role authenticated');
}

async function mint(ownerId, versionId) {
  const [link] = await sql.begin(async (tx) => {
    await asOwner(tx, ownerId);
    return tx`select id, token from public.create_preview_link(${versionId}::uuid)`;
  });
  return link;
}

test.afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('a logged-out visitor gets a frame that paints', async ({ page }) => {
  test.setTimeout(120_000);
  const ownerId = randomUUID();
  const gameId = `w${randomBytes(4).toString('hex')}`.slice(0, 12);
  const handle = `wk${gameId}`.slice(0, 32);
  const indexHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000"><canvas id="c" width="64" height="64" style="width:100%;height:100%;display:block"></canvas><script src="game.js"></script></body></html>';
  const gameJs = '(()=>{const c=document.getElementById("c");const g=c.getContext("2d");g.fillStyle="#c4ff3d";g.fillRect(0,0,c.width,c.height);if(window.Meshground)window.Meshground.ready();})();';
  const storage = createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from('games');
  const scriptHits = [];
  page.on('response', (res) => {
    if (new URL(res.url()).pathname.endsWith('/game.js')) scriptHits.push(res.status());
  });
  try {
    await sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${ownerId}::uuid, 'authenticated', 'authenticated', ${`${ownerId}@example.test`}, '', now(), now())
    `;
    await sql`insert into public.profiles (id, handle) values (${ownerId}::uuid, ${handle})`;
    await sql`
      insert into public.games (id, slug, owner_id, creator, title, tags, stage)
      values (${gameId}, ${gameId}, ${ownerId}::uuid, ${handle}, ${`Phone ${gameId}`}, '{}', 'pending')
    `;
    const [version] = await sql`
      insert into public.game_validations (game_id, version, bundle_sha256, status)
      values (${gameId}, 1, ${sha}, 'passed')
      returning id
    `;
    for (const [path, body, type] of [
      [`${gameId}/1/index.html`, indexHtml, 'text/html; charset=utf-8'],
      [`${gameId}/1/game.js`, gameJs, 'text/javascript; charset=utf-8'],
    ]) {
      const uploaded = await storage.upload(path, Buffer.from(body), { contentType: type, upsert: true });
      if (uploaded.error) throw uploaded.error;
    }
    await sql`
      insert into public.game_assets (game_id, version, path, expected_type, status, size_bytes, content_at)
      values (${gameId}, 1, 'game.js', 'text', 'uploaded', ${Buffer.byteLength(gameJs)}, now())
    `;
    const link = await mint(ownerId, version.id);
    const opened = await page.goto(`/p/${link.token}`);
    expect(opened?.status()).toBe(200);
    await page.evaluate(() => {
      window.__mgReady = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 8000);
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === '__MG_READY') {
            clearTimeout(timer);
            resolve('ready');
          }
        });
      });
    });
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('iframe.mg-frame')).toBeVisible();
    expect(await page.evaluate(() => window.__mgReady)).toBe('ready');
    expect(scriptHits).toContain(200);
    const pixel = await page.frameLocator('iframe.mg-frame').locator('canvas').evaluate((canvas) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const data = ctx.getImageData(2, 2, 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    });
    expect(pixel).toEqual([196, 255, 61, 255]);
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: shotPath('sl-6-webkit-390.png') });
    await page.locator('iframe.mg-frame').screenshot({ path: shotPath('sl-6-webkit-390-frame.png') });
  } finally {
    await sql`delete from public.games where id = ${gameId}`.catch(() => {});
    await sql`delete from public.profiles where id = ${ownerId}::uuid`.catch(() => {});
    await sql`delete from auth.users where id = ${ownerId}::uuid`.catch(() => {});
    await storage.remove([`${gameId}/1/index.html`, `${gameId}/1/game.js`]).catch(() => {});
  }
});
