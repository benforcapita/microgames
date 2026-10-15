import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { GAME_ID_RE, invalidIds, parseArgs, planRow, resolveTarget, summarize } from './backfill-input.mjs';

describe('IS-4 backfill: planRow', () => {
  it('fills unknown rows', () => assert.deepEqual(planRow('unknown', 'both'), { action: 'update', from: 'unknown', to: 'both' }));
  it('null / bad stored values read as unknown', () => assert.equal(planRow(null, 'mobile').action, 'update'));
  it('unchanged rows are left alone', () => assert.equal(planRow('desktop', 'desktop').action, 'same'));
  it('already-classified rows need --force', () => {
    assert.equal(planRow('mobile', 'both').action, 'skip');
    assert.deepEqual(planRow('mobile', 'both', true), { action: 'update', from: 'mobile', to: 'both' });
  });
  it('a missing classification never writes', () => assert.equal(planRow('unknown', undefined, true).action, 'skip'));
  it('summarize counts actions', () => assert.deepEqual(summarize([{ action: 'update' }, { action: 'same' }, { action: 'missing' }]), { update: 1, same: 1, skip: 0, missing: 1 }));
});

describe('IS-4 backfill: target guards (REST only)', () => {
  const remote = { PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co', SUPABASE_SECRET_KEY: 'x' };
  it('parses --allow-remote / --yes / --ids / --force', () => {
    assert.deepEqual(parseArgs(['--dry-run', '--allow-remote', '--yes', '--force', '--ids', 'a, b']),
      { dryRun: true, apply: false, force: true, all: false, yes: true, allowRemote: true, ids: ['a', 'b'], rest: true });
  });
  it('no env -> local stack, REST', () => assert.deepEqual(resolveTarget({}, parseArgs([])), { mode: 'local', db: 'rest' }));
  it('remote without --allow-remote is refused', () => assert.match(resolveTarget(remote, parseArgs([])).error ?? "", /--allow-remote/));
  it('remote needs typed confirmation unless --yes', () => {
    assert.equal(resolveTarget(remote, parseArgs(['--allow-remote'])).needConfirm, true);
    const t = resolveTarget(remote, parseArgs(['--allow-remote', '--yes']));
    assert.deepEqual([t.mode, t.db, t.ref, t.needConfirm], ['remote', 'rest', 'abcdefghijkl', false]);
  });
  it('DATABASE_URL is ignored: always REST', () => {
    const t = resolveTarget({ ...remote, DATABASE_URL: 'postgresql://u@db.example.com:5432/postgres' }, parseArgs(['--allow-remote', '--yes']));
    assert.equal(t.db, 'rest');
    assert.equal(t.env?.DATABASE_URL, undefined);
  });
  it('the script never opens Postgres and only writes behind the dry-run check, compare-and-set', () => {
    const src = fs.readFileSync(new URL('../backfill-input-support.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from 'postgres'/);
    assert.ok(src.indexOf('if (args.dryRun)') < src.indexOf('.update('), 'dry-run returns before any update');
    assert.match(src, /\.eq\('input_support', g\.input_support\)/);
  });
});

describe('IS-4 QA: dry run is the default; --apply writes', () => {
  it('no flags -> dry run', () => assert.deepEqual([parseArgs([]).dryRun, parseArgs([]).apply], [true, false]));
  it('--apply -> writes', () => assert.deepEqual([parseArgs(['--apply']).dryRun, parseArgs(['--apply']).apply], [false, true]));
  it('--dry-run wins over --apply', () => assert.equal(parseArgs(['--apply', '--dry-run']).dryRun, true));
  it('remote guards still apply with --apply', () => {
    const remote = { PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co', SUPABASE_SECRET_KEY: 'x' };
    assert.match(resolveTarget(remote, parseArgs(['--apply'])).error ?? '', /--allow-remote/);
    assert.equal(resolveTarget(remote, parseArgs(['--apply', '--allow-remote'])).needConfirm, true);
  });
  it('the script writes only when not dry-run (default), and says how to apply', () => {
    const src = fs.readFileSync(new URL('../backfill-input-support.mjs', import.meta.url), 'utf8');
    assert.match(src, /if \(args\.error\) die\(args\.error\);/);
    assert.match(src, /re-run with --apply to write/);
  });
});

describe('IS-4 QA: --ids are validated before reaching PostgREST', () => {
  it('uses the shared game id regex', () => assert.equal(String(GAME_ID_RE), String(/^[A-Za-z0-9_-]{1,32}$/)));
  it('accepts base64url ids, including - and _', () => {
    assert.equal(parseArgs(['--ids', 'pr1smp0p,a-b_C9']).error, undefined);
    assert.deepEqual(invalidIds(['pr1smp0p', 'a-b', 'a_b', 'x'.repeat(32)]), []);
  });
  it('rejects filter injection and anything else outside the regex', () => {
    for (const bad of ['a),stage.eq.live', 'id.in.(x)', 'a b', 'a.b', 'a(b', 'a"b', "a'b", 'x'.repeat(33), 'é', '*']) {
      const r = parseArgs(['--ids', bad]);
      assert.match(r.error ?? '', /invalid --ids/, bad);
    }
  });
  it('one bad id aborts the whole run', () => assert.match(parseArgs(['--ids', 'ok1,bad)x']).error ?? '', /"bad\)x"/));
  it('--ids with no value is an error, not "all games"', () => {
    assert.match(parseArgs(['--ids']).error ?? '', /needs a comma-separated list/);
    assert.match(parseArgs(['--ids', '--apply']).error ?? '', /needs a comma-separated list/);
  });
  it('the script never builds a raw .or() filter from --ids', () => {
    const src = fs.readFileSync(new URL('../backfill-input-support.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\.or\(/);
    assert.match(src, /q\.in\('id', args\.ids\)/);
  });
});
