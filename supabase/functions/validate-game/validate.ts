// Core of the validate-game Edge Function, with I/O behind small interfaces so it can be tested
// without a running stack. A failing bundle moves pending -> rejected. A passing one stays pending
// while manual review is on (the default), and moves pending -> proving when it is off
// (see stageAfterValidation in game-rules.ts).
import { manualReviewEnabled } from '../../../src/lib/manual-review.ts';
import { analyzeGame, type StaticReport } from '../../../src/lib/server/static-check.ts';
import { stageAfterValidation, type Stage, type ValidationStatus } from '../../../src/lib/server/game-rules.ts';

export interface ValidationRow {
  id: string;
  status: ValidationStatus;
  bundle_sha256: string;
  version: number;
}

export interface Store {
  /** Current stage, or null if the game doesn't exist. */
  gameStage(gameId: string): Promise<Stage | null>;
  /** Bundle bytes (`<id>/index.html` in the games bucket), or null if missing. */
  bundle(gameId: string): Promise<Uint8Array | null>;
  findValidation(gameId: string, sha256: string): Promise<ValidationRow | null>;
  /**
   * Atomically insert the validation row (unique on game_id + bundle_sha256) and apply the stage
   * transition. Returns null if another run inserted the same bundle first.
   */
  recordValidation(input: {
    gameId: string;
    sha256: string;
    status: ValidationStatus;
    report: StaticReport;
    nextStage: (current: Stage) => Stage;
    manualReview: boolean;
  }): Promise<{ row: ValidationRow; stage: Stage } | null>;
  /**
   * For a bundle that already has a verdict: atomically apply that stored verdict's transition if the game
   * is (still, or again) 'pending'. Returns the resulting stage, or null if the game/verdict is gone.
   */
  applyStoredVerdict(gameId: string, sha256: string, manualReview: boolean): Promise<Stage | null>;
}

export interface ValidateResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function statusFromReport(report: StaticReport): ValidationStatus {
  return report.status === 'fail' ? 'failed' : 'passed'; // warnings still publish
}

/** Game ids are base64url (createGame uses randomBytes(6).toString('base64url')), so - and _ are valid. */
export const GAME_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function runtimeManualReview(): boolean {
  let raw: string | undefined;
  const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno;
  if (deno?.env?.get) {
    try { raw = deno.env.get('MG_MANUAL_REVIEW'); } catch { raw = undefined; }
  }
  if (raw == null && typeof process !== 'undefined') raw = process.env.MG_MANUAL_REVIEW;
  return manualReviewEnabled(raw);
}

export async function validateGame(store: Store, gameId: string, opts: { manualReview?: boolean } = {}): Promise<ValidateResult> {
  const manualReview = opts.manualReview ?? runtimeManualReview();
  if (!GAME_ID_RE.test(gameId)) return { httpStatus: 400, body: { error: 'invalid gameId' } };
  const stage = await store.gameStage(gameId);
  if (!stage) return { httpStatus: 404, body: { error: 'game not found' } };
  const bytes = await store.bundle(gameId);
  if (!bytes) return { httpStatus: 422, body: { error: 'bundle missing', gameId, stage } };

  const sha256 = await sha256Hex(bytes);
  const existing = await store.findValidation(gameId, sha256);
  if (existing) {
    // Idempotent: same bundle -> same verdict, no new row. A game that is pending again (the same bundle
    // re-set to pending) still gets the stored verdict's move; any other stage is left untouched.
    return { httpStatus: 200, body: { gameId, sha256, status: existing.status, validationId: existing.id, reused: true, ...(await settleReused(store, gameId, sha256, manualReview)) } };
  }

  const report = analyzeGame(bytes);
  const status = statusFromReport(report);
  const recorded = await store.recordValidation({ gameId, sha256, status, report, manualReview, nextStage: (s) => stageAfterValidation(s, status, manualReview) });
  if (!recorded) {
    const raced = await store.findValidation(gameId, sha256);
    return { httpStatus: 200, body: { gameId, sha256, status: raced?.status, validationId: raced?.id, reused: true, ...(await settleReused(store, gameId, sha256, manualReview)) } };
  }
  return {
    httpStatus: 200,
    body: {
      gameId, sha256, status, stage: recorded.stage, previousStage: stage, validationId: recorded.row.id, version: recorded.row.version, reused: false, inputSupport: report.inputSupport?.class ?? 'unknown',
      level: report.status, failed: report.checks.filter((c) => c.level === 'fail').map((c) => c.id),
      warned: report.checks.filter((c) => c.level === 'warn').map((c) => c.id),
    },
  };
}

/** Reused verdict: re-read the stage (a concurrent run may have moved it) and, if still pending, apply it. */
async function settleReused(store: Store, gameId: string, sha256: string, manualReview: boolean): Promise<{ stage: Stage | null; previousStage?: Stage; moved?: boolean }> {
  const stage = await store.gameStage(gameId);
  if (stage !== 'pending') return { stage };
  const next = (await store.applyStoredVerdict(gameId, sha256, manualReview)) ?? (await store.gameStage(gameId));
  return next && next !== 'pending' ? { stage: next, previousStage: 'pending', moved: true } : { stage: next };
}
