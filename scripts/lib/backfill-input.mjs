// Pure helpers for scripts/backfill-input-support.mjs (unit-tested in backfill-input.test.ts). No I/O here.
import { resolveTarget as resolveThumbTarget } from './thumbs.mjs';

export const VALID = ['mobile', 'desktop', 'both', 'unknown'];

/** Same id rule as validate-game (GAME_ID_RE) and createGame's base64url ids. Slugs are not accepted. */
export const GAME_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Invalid --ids entries; anything returned here must abort the run (the ids go into a PostgREST .in() filter). */
export function invalidIds(ids) {
  return (ids ?? []).filter((id) => !GAME_ID_RE.test(id));
}

export const BOOL_FLAGS = ['--dry-run', '--apply', '--force', '--yes', '--allow-remote'];

/**
 * Strict parser. Dry run is the DEFAULT; writing needs --apply (--dry-run always wins over --apply).
 * --ids takes a value as `--ids a,b` or `--ids=a,b`; an empty or missing value, a repeated --ids, any id
 * outside GAME_ID_RE, an unknown flag, a boolean flag given a value, or a stray positional argument is an
 * error ({ error }), which the script turns into exit 2 before it connects anywhere.
 */
/**
 * @typedef {{ dryRun: boolean, apply: boolean, force: boolean, yes: boolean, allowRemote: boolean, ids?: string[], rest: true, error?: string }} BackfillArgs
 * @param {string[]} argv
 * @returns {BackfillArgs}
 */
export function parseArgs(argv) {
  const seen = new Set();
  /** @type {string[] | undefined} */
  let ids;
  /** @param {string} error @returns {BackfillArgs} */
  const fail = (error) => ({ dryRun: true, apply: false, force: false, yes: false, allowRemote: false, rest: true, error });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (name === '--ids') {
      if (ids !== undefined) return fail('--ids given more than once');
      let value;
      if (eq > 0) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) return fail('--ids needs a comma-separated list of game ids');
        i++;
      }
      ids = value.split(',').map((x) => x.trim());
      if (!value.trim() || ids.every((x) => !x)) return fail('--ids needs a comma-separated list of game ids');
      const bad = invalidIds(ids);
      if (bad.length) return fail(`invalid --ids (must match ${GAME_ID_RE}): ${bad.map((x) => JSON.stringify(x)).join(', ')}`);
      continue;
    }
    if (BOOL_FLAGS.includes(name)) {
      if (eq > 0 && arg.startsWith('--')) return fail(`${name} does not take a value`);
      seen.add(name);
      continue;
    }
    return fail(arg.startsWith('-') ? `unknown flag: ${arg.split('=')[0]}` : `unexpected argument: ${JSON.stringify(arg)}`);
  }
  const apply = seen.has('--apply') && !seen.has('--dry-run');
  return { dryRun: !apply, apply, force: seen.has('--force'), yes: seen.has('--yes'), allowRemote: seen.has('--allow-remote'), ...(ids ? { ids } : {}), rest: true };
}

/** Same connection rules as capture-thumbs, but always REST (PostgREST + Storage over HTTP(S); never Postgres). */
export function resolveTarget(env, args) {
  // --force here only recomputes already-classified rows; it never needs the thumbs-specific --all/--yes pairing.
  return resolveThumbTarget(env, { ...args, force: false, rest: true });
}

/**
 * Decide the update for one game. Default: only rows still 'unknown' are filled in; --force recomputes all.
 * Returns { action: 'update' | 'same' | 'skip', from, to, reason? }.
 */
export function planRow(stored, computed, force = false) {
  const from = VALID.includes(stored) ? stored : 'unknown';
  if (!VALID.includes(computed)) return { action: 'skip', from, to: from, reason: 'no classification' };
  if (computed === from) return { action: 'same', from, to: computed };
  if (from !== 'unknown' && !force) return { action: 'skip', from, to: computed, reason: 'already classified (use --force to recompute)' };
  return { action: 'update', from, to: computed };
}

export function summarize(rows) {
  const out = { update: 0, same: 0, skip: 0, missing: 0 };
  for (const r of rows) out[r.action] = (out[r.action] ?? 0) + 1;
  return out;
}
