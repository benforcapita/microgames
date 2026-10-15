import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { BLANK_STDEV, blankVerdict, parseArgs, projectRef, resolveTarget, thumbKey } from './thumbs.mjs';
import { validateThumb } from '../../src/lib/server/upload.ts';

const local = { PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', SUPABASE_SECRET_KEY: 'k' };
const remote = { PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', DATABASE_URL: 'postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres', SUPABASE_SECRET_KEY: 'k' };
const a = (...argv: string[]) => parseArgs(argv);
const err = (r: { error?: string }) => r.error ?? '';

test('parseArgs reads flags and options', () => {
  const o = a('--dry-run', '--ids', 'x, y', '--settle', '500');
  assert.equal(o.dryRun, true);
  assert.deepEqual(o.ids, ['x', 'y']);
  assert.equal(o.settleMs, 500);
  assert.equal(a().dryRun, false);
});

test('no env -> local stack from supabase status', () => {
  assert.deepEqual(resolveTarget({}, a()), { mode: 'local', db: 'pg' });
});

test('partial env is an error, never a silent local fallback', () => {
  for (const k of ['PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    const env: Record<string, string> = { ...remote };
    delete env[k];
    const r = resolveTarget(env, a('--allow-remote', '--yes'));
    assert.match(err(r), new RegExp(`missing required env: ${k}`));
  }
  assert.match(err(resolveTarget({ DATABASE_URL: remote.DATABASE_URL }, a())), /PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY/);
  assert.match(err(resolveTarget({ PUBLIC_SUPABASE_URL: remote.PUBLIC_SUPABASE_URL }, a('--allow-remote', '--yes'))), /SUPABASE_SECRET_KEY/);
});

test('DATABASE_URL absent -> REST mode (default); present -> direct Postgres unless --rest', () => {
  const { DATABASE_URL: _db, ...restEnv } = remote;
  const r = resolveTarget(restEnv, a('--allow-remote', '--yes'));
  assert.equal(r.mode, 'remote');
  assert.equal(r.db, 'rest');
  assert.equal(r.env?.DATABASE_URL, undefined);
  assert.equal(resolveTarget(remote, a('--allow-remote', '--yes')).db, 'pg');
  const forced = resolveTarget(remote, a('--allow-remote', '--yes', '--rest'));
  assert.equal(forced.db, 'rest');
  assert.equal(forced.env?.DATABASE_URL, undefined, 'REST mode never carries a DB URL');
  const { DATABASE_URL: _l, ...localRest } = local;
  assert.deepEqual([resolveTarget(localRest, a()).mode, resolveTarget(localRest, a()).db], ['env', 'rest']);
  assert.deepEqual(resolveTarget({}, a('--rest')), { mode: 'local', db: 'rest' });
  assert.deepEqual(resolveTarget({}, a()), { mode: 'local', db: 'pg' });
});

test('REST mode keeps the remote guards', () => {
  const { DATABASE_URL: _db, ...restEnv } = remote;
  assert.match(err(resolveTarget(restEnv, a())), /--allow-remote/);
  assert.equal(resolveTarget(restEnv, a('--allow-remote')).needConfirm, true);
  assert.equal(resolveTarget(restEnv, a('--allow-remote')).ref, 'abcdefghijklmnop');
  assert.match(err(resolveTarget(restEnv, a('--force', '--all', '--allow-remote'))), /--yes/);
  // A remote DATABASE_URL is irrelevant (and ignored) in REST mode; a remote one in pg mode is remote.
  assert.equal(resolveTarget({ ...local, DATABASE_URL: remote.DATABASE_URL }, a('--rest')).mode, 'env');
});

test('full loopback env is used as-is', () => {
  assert.equal(resolveTarget(local, a()).mode, 'env');
});

test('remote needs --allow-remote, then typed ref confirmation unless --yes', () => {
  assert.match(err(resolveTarget(remote, a())), /--allow-remote/);
  const r = resolveTarget(remote, a('--allow-remote'));
  assert.equal(r.mode, 'remote');
  assert.equal(r.ref, 'abcdefghijklmnop');
  assert.equal(r.needConfirm, true);
  assert.equal(resolveTarget(remote, a('--allow-remote', '--yes')).needConfirm, false);
  // A loopback API URL with a remote DB is still remote.
  assert.match(err(resolveTarget({ ...local, DATABASE_URL: remote.DATABASE_URL }, a())), /--allow-remote/);
});

test('--force with --all is refused without --yes (local and remote)', () => {
  assert.match(err(resolveTarget({}, a('--force', '--all'))), /--yes/);
  assert.match(err(resolveTarget(remote, a('--force', '--all', '--allow-remote'))), /--yes/);
  assert.equal(resolveTarget({}, a('--force', '--all', '--yes')).mode, 'local');
  assert.equal(resolveTarget({}, a('--force')).mode, 'local');
});

test('projectRef', () => {
  assert.equal(projectRef('https://abcdefghijklmnop.supabase.co'), 'abcdefghijklmnop');
  assert.equal(projectRef('https://db.example.com'), 'db.example.com');
});

const solid = (r: number, g: number, b: number) => sharp({ create: { width: 640, height: 360, channels: 3, background: { r, g, b } } });

test('blankVerdict flags black, white and single-colour frames', async () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [40, 90, 200]]) {
    assert.equal(blankVerdict(await solid(r, g, b).stats()).blank, true);
  }
});

test('blankVerdict flags near-single-colour noise below the threshold', async () => {
  const raw = Buffer.alloc(640 * 360 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 20 + (i % 7); // tiny variation
  const v = blankVerdict(await sharp(raw, { raw: { width: 640, height: 360, channels: 3 } }).stats());
  assert.equal(v.blank, true);
  assert.ok(v.stdev < BLANK_STDEV);
});

test('blankVerdict passes a real-looking frame', async () => {
  const half = await solid(10, 10, 30).composite([{ input: await solid(240, 80, 40).resize(320, 180).png().toBuffer(), left: 100, top: 60 }]).png().toBuffer();
  const v = blankVerdict(await sharp(half).stats());
  assert.equal(v.blank, false);
  assert.ok(v.stdev > BLANK_STDEV);
});

test('blankVerdict ignores the alpha channel', async () => {
  const s = await sharp({ create: { width: 64, height: 36, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).stats();
  assert.equal(blankVerdict(s).blank, true);
});

test('capture output (640x360 webp) passes the real validateThumb; oversize does not', async () => {
  const webp = await solid(10, 200, 30).webp({ quality: 82 }).toBuffer();
  const ok = await validateThumb(new File([webp], 'thumb.webp', { type: 'image/webp' }));
  assert.ok('thumb' in ok);
  const big = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#123' } }).webp().toBuffer();
  const bad = await validateThumb(new File([big], 'thumb.webp', { type: 'image/webp' }));
  assert.ok('error' in bad);
});

test('thumbKey is versioned, unique and matches the CDN file pattern', () => {
  const k1 = thumbKey(1_760_000_000_000, () => 0.1);
  const k2 = thumbKey(1_760_000_000_001, () => 0.1);
  assert.notEqual(k1, k2);
  assert.notEqual(k1, 'thumb.webp');
  const FILE_RE = /^(index\.html|thumb(-[a-z0-9]{4,24})?\.(png|jpg|webp))$/;
  for (let i = 0; i < 50; i++) assert.match(thumbKey(), FILE_RE);
});
