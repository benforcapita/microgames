// Pure helpers for scripts/backfill-input-support.mjs (unit-tested in backfill-input.test.ts). No I/O here.
import { parseArgs as parseThumbArgs, resolveTarget as resolveThumbTarget } from './thumbs.mjs';

export const VALID = ['mobile', 'desktop', 'both', 'unknown'];

export function parseArgs(argv) {
  const a = parseThumbArgs(argv);
  return { dryRun: a.dryRun, force: a.force, all: a.all, yes: a.yes, allowRemote: a.allowRemote, ids: a.ids, rest: true };
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
