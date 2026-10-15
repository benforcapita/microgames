// Pure helpers for scripts/backfill-input-support.mjs (unit-tested in backfill-input.test.ts). No I/O here.
import { parseArgs as parseThumbArgs, resolveTarget as resolveThumbTarget } from './thumbs.mjs';

export const VALID = ['mobile', 'desktop', 'both', 'unknown'];

/** Same id rule as validate-game (GAME_ID_RE) and createGame's base64url ids. Slugs are not accepted. */
export const GAME_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Invalid --ids entries; anything returned here must abort the run (the ids go into a PostgREST .in() filter). */
export function invalidIds(ids) {
  return (ids ?? []).filter((id) => !GAME_ID_RE.test(id));
}

/**
 * Dry run is the DEFAULT. Writing needs an explicit --apply (and --dry-run always wins over --apply).
 * `--ids` given with no value is an error rather than "all games".
 */
export function parseArgs(argv) {
  const a = parseThumbArgs(argv);
  const apply = argv.includes('--apply') && !a.dryRun;
  const idsFlag = argv.includes('--ids');
  const ids = idsFlag ? (a.ids ?? []) : undefined;
  const error = idsFlag && (!ids.length || ids.some((x) => x.startsWith('--')))
    ? '--ids needs a comma-separated list of game ids'
    : ids && invalidIds(ids).length
      ? `invalid --ids (must match ${GAME_ID_RE}): ${invalidIds(ids).map((x) => JSON.stringify(x)).join(', ')}`
      : undefined;
  return { dryRun: !apply, apply, force: a.force, all: a.all, yes: a.yes, allowRemote: a.allowRemote, ids, rest: true, ...(error ? { error } : {}) };
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
