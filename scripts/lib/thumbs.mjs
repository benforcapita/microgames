// Pure helpers for scripts/capture-thumbs.mjs (unit-tested in thumbs.test.ts). No I/O here.

export const LOOPBACK = /^(https?|postgres(ql)?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
export const REMOTE_ENV = ['PUBLIC_SUPABASE_URL', 'DATABASE_URL', 'SUPABASE_SECRET_KEY'];

/** Below this per-channel standard deviation (0–255) a frame counts as blank / near-single-colour. */
export const BLANK_STDEV = 6;

export function parseArgs(argv) {
  const has = (n) => argv.includes(`--${n}`);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    dryRun: has('dry-run'),
    force: has('force'),
    all: has('all'),
    yes: has('yes'),
    allowRemote: has('allow-remote'),
    build: has('build'),
    ids: opt('ids')?.split(',').map((s) => s.trim()).filter(Boolean),
    out: opt('out'),
    settleMs: Number(opt('settle') ?? 3000),
    retryMs: Number(opt('retry-settle') ?? 3000),
  };
}

/** `https://abcd.supabase.co` -> `abcd`; otherwise the host. */
export function projectRef(url) {
  try {
    const host = new URL(url).hostname;
    const m = host.match(/^([a-z0-9]{8,40})\.supabase\.(co|in|net)$/);
    return m ? m[1] : host;
  } catch {
    return String(url);
  }
}

/**
 * Decides where the script connects. Returns { mode: 'local' } (use `supabase status`),
 * { mode: 'remote', env, ref, needConfirm } or { error }.
 * Any of the remote env vars set means "remote intent": then all must be set, no silent local fallback.
 */
export function resolveTarget(env, args) {
  if (args.force && args.all && !args.yes) return { error: '--force with --all overwrites every thumbnail; add --yes to confirm.' };
  const set = REMOTE_ENV.filter((k) => env[k]);
  if (!set.length) return { mode: 'local' };
  const missing = REMOTE_ENV.filter((k) => !env[k]);
  if (missing.length) return { error: `missing required env: ${missing.join(', ')} (set all of ${REMOTE_ENV.join(', ')} or none for the local stack)` };
  const picked = Object.fromEntries([...REMOTE_ENV, 'PUBLIC_SUPABASE_PUBLISHABLE_KEY'].map((k) => [k, env[k]]));
  const remote = !LOOPBACK.test(env.PUBLIC_SUPABASE_URL) || !LOOPBACK.test(env.DATABASE_URL);
  if (!remote) return { mode: 'env', env: picked };
  if (!args.allowRemote) return { error: 'refusing non-local Supabase; pass --allow-remote to target it.' };
  return { mode: 'remote', env: picked, ref: projectRef(env.PUBLIC_SUPABASE_URL), needConfirm: !args.yes };
}

/** sharp `stats()` -> blank verdict. Ignores alpha; blank when every colour channel is near-constant. */
export function blankVerdict(stats, threshold = BLANK_STDEV) {
  const colour = stats.channels.slice(0, 3);
  const stdev = Math.max(...colour.map((c) => c.stdev));
  return { blank: stdev < threshold, stdev: Math.round(stdev * 100) / 100 };
}

/** Versioned object key, so a concurrent run can never overwrite an object another row points at. */
export function thumbKey(now = Date.now(), rand = Math.random) {
  const tag = now.toString(36) + Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `thumb-${tag}.webp`;
}
