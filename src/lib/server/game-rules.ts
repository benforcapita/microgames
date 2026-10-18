/** Graduation, telemetry, tag, and slug rules. No database or environment access. */

export const GRADUATION_DEFAULTS = {
  minPlays: 100,
  maxFirstFrameMs: 3000,
  minFirstFrameOkRate: 0.9,
  maxCrashRate: 0.05,
  minStartRate: 0.6,
  minCompletionRate: 0.25,
  minMedianSessionSec: 60,
  minAvgRating: 3,
  minRatingsForRatingGate: 10,
};

export type GraduationRules = typeof GRADUATION_DEFAULTS;

export const MAX_SESSION_MS = 4 * 3600_000;
export const MAX_FIRST_FRAME_MS = 60_000;

export interface HealthCheck {
  key: string;
  label: string;
  value: number | null;
  target: number;
  format: 'count' | 'pct' | 'sec' | 'stars';
  comparator: 'gte' | 'lte';
  pass: boolean;
}

export interface HealthStats {
  plays: number;
  ffOk: number | null;
  crashRate: number | null;
  startRate: number | null;
  completionRate: number | null;
  medianMs: number | null;
  avgRating: number | null;
  ratingCount: number;
}

export function assessHealth(
  stats: HealthStats,
  rules: GraduationRules = GRADUATION_DEFAULTS,
): { checks: HealthCheck[]; eligible: boolean } {
  const G = rules;
  const check = (
    key: string, label: string, value: number | null, target: number, format: HealthCheck['format'],
    comparator: HealthCheck['comparator'] = 'gte', passOverride?: boolean,
  ): HealthCheck => ({
    key, label, value, target, format, comparator,
    pass: passOverride ?? (value !== null && (comparator === 'gte' ? value >= target : value <= target)),
  });

  const checks = [
    check('plays', 'Plays measured', stats.plays, G.minPlays, 'count'),
    check('first_frame', `First frame under ${G.maxFirstFrameMs / 1000}s`, stats.ffOk, G.minFirstFrameOkRate, 'pct'),
    check('crash', 'Crash rate', stats.crashRate, G.maxCrashRate, 'pct', 'lte'),
    check('start', 'Start rate', stats.startRate, G.minStartRate, 'pct'),
    check('completion', 'Loop completion rate', stats.completionRate, G.minCompletionRate, 'pct'),
    check('session', 'Median session', stats.medianMs === null ? null : stats.medianMs / 1000, G.minMedianSessionSec, 'sec'),
    check('rating', `Community rating (${stats.ratingCount} ${stats.ratingCount === 1 ? "vote" : "votes"})`, stats.avgRating, G.minAvgRating, 'stars', 'gte',
      stats.ratingCount < G.minRatingsForRatingGate ? true : undefined),
  ];
  return { checks, eligible: checks.every((c) => c.pass) };
}

/**
 * Parse an unknown sample into a millisecond number, Infinity, -Infinity, or null if invalid.
 * Null, undefined, empty/blank strings, non-numeric values, and NaN return null.
 */
function parseTelemetryMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n;
}

export function clampFirstFrameMs(value: unknown): number | null {
  const n = parseTelemetryMs(value);
  if (n === null || n === Number.NEGATIVE_INFINITY) return null;
  if (n === Number.POSITIVE_INFINITY || n > MAX_FIRST_FRAME_MS) return MAX_FIRST_FRAME_MS;
  if (n < 0) return 0;
  return Math.round(n);
}

export function clampDurationMs(value: unknown): number {
  const n = parseTelemetryMs(value);
  if (n === null || n === Number.NEGATIVE_INFINITY) return 0;
  if (n === Number.POSITIVE_INFINITY) return MAX_SESSION_MS;
  return Math.min(MAX_SESSION_MS, Math.max(0, Math.round(n)));
}

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'game';

export function normalizeTags(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((t) => slugify(t)).filter((t) => t && t !== 'game'))].slice(0, 6);
}

/** When `taken` is set, append a short slice of the new game id so the slug stays unique. */
export function uniqueSlug(title: string, taken: boolean, id: string): string {
  const base = slugify(title);
  return taken ? `${base}-${id.slice(0, 4).toLowerCase()}` : base;
}

/** Prior weight C for Bayesian rating: a game behaves as if it already had C votes at the global mean. */
export const BAYES_PRIOR_VOTES = 10;

/**
 * Bayesian average `(C*m + sum) / (C + n)`: shrinks games with few votes toward the global mean `m`,
 * so one 5★ vote does not outrank 200 votes at 4.8★. Must stay in sync with the SQL in `listGames`.
 */
export function bayesianRating(avg: number | null, count: number, globalMean: number, priorVotes = BAYES_PRIOR_VOTES): number {
  const n = Math.max(0, count);
  const sum = avg === null || n === 0 ? 0 : avg * n;
  return (priorVotes * globalMean + sum) / (priorVotes + n);
}

/** Orders games for `sort=rated`: Bayesian average desc, then more votes first. */
export function compareByBayes(globalMean: number) {
  return (a: { avgRating: number | null; ratingCount: number }, b: { avgRating: number | null; ratingCount: number }) =>
    bayesianRating(b.avgRating, b.ratingCount, globalMean) - bayesianRating(a.avgRating, a.ratingCount, globalMean) ||
    b.ratingCount - a.ratingCount;
}

/* ---------- Stages (SP-3) ---------- */

/** All game stages. `pending` = submitted, awaiting validation; `rejected` = failed validation. */
export const STAGES = ['pending', 'proving', 'live', 'rejected'] as const;
export type Stage = (typeof STAGES)[number];
/** Stages that may appear in any public list, feed, creator page, tag cloud or stat. */
export const PUBLIC_STAGES = ['proving', 'live'] as const satisfies readonly Stage[];

export const isPublicStage = (stage: string): boolean => (PUBLIC_STAGES as readonly string[]).includes(stage);

/**
 * PV-1 (Ben's product rule), the ONE place that decides what the site may show or recommend to other users:
 *
 *   listable = live AND passed the headless check
 *
 * Proving games (static check passed) stay playable by direct link (/play/<id> and the CDN, see canViewGame)
 * but are never listed: not on the home feed, lists, tags, search, featured, related/"more from", other
 * people's profile views or the public Proving Grounds. Only their owner sees them in their own lists.
 * There is no headless runner yet, so `headlessPassed` is absent everywhere and a game can only become
 * listable by graduating to 'live' (which itself requires real-play health checks). When the runner lands,
 * set `headlessPassed` on the game and it gates live games too; an explicit `false` already unlists.
 */
export const LISTABLE_STAGES = ['live'] as const satisfies readonly Stage[];

export function isListable(game: { stage: Stage | string; headlessPassed?: boolean | null }): boolean {
  return (LISTABLE_STAGES as readonly string[]).includes(game.stage) && game.headlessPassed !== false;
}

/**
 * Which stages a list query may return. Every public list is limited to LISTABLE_STAGES. Owner-scoped
 * queries (require ownerId) may opt in to more: `includeUnlisted` adds their own proving games (profile,
 * /proving), `includeUnpublished` adds pending/rejected too (the creator's dashboard).
 */
export function visibleStages(opts: { stage?: Stage; ownerId?: string; includeUnpublished?: boolean; includeUnlisted?: boolean } = {}): Stage[] {
  const allowed: readonly Stage[] = opts.ownerId && opts.includeUnpublished ? STAGES : opts.ownerId && opts.includeUnlisted ? PUBLIC_STAGES : LISTABLE_STAGES;
  if (opts.stage) return allowed.includes(opts.stage) ? [opts.stage] : [];
  return [...allowed];
}

export type ValidationStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

/**
 * Stage after a validation run.
 * Only moves games out of `pending`; never demotes a published game or resurrects a rejected one
 * on a stale/duplicate result. queued/running/error leave the stage unchanged.
 * `manualReview` defaults on: a pass stays `pending` until a person sets the stage to `proving`.
 * Pass `false` to auto-publish a pass to `proving` (MG_MANUAL_REVIEW off).
 */
export function stageAfterValidation(current: Stage, status: ValidationStatus, manualReview = true): Stage {
  if (current !== 'pending') return current;
  if (status === 'passed') return manualReview ? current : 'proving';
  if (status === 'failed') return 'rejected';
  return current;
}

/**
 * Who may open a game's page: anyone for published stages; only the owner for their own
 * pending/rejected game (so they can check it while validation runs). Everyone else gets a 404.
 */
export function canViewGame(game: { stage: Stage; ownerId: string | null } | null, viewerId?: string | null): boolean {
  if (!game) return false;
  if (isPublicStage(game.stage)) return true;
  return !!viewerId && !!game.ownerId && game.ownerId === viewerId;
}

/** createGame reads back the row it just inserted, which may be 'pending' (SP-5 default). */
export const CREATED_GAME_LOOKUP = { includeUnpublished: true } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RT-2 expand step: ratings.user_id mirrors voter when voter is an auth user id, else null. */
export function ratingUserId(voter: string): string | null {
  return UUID_RE.test(voter) ? voter.toLowerCase() : null;
}
