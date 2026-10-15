// Core of the validate-game Edge Function, with I/O behind small interfaces so it can be tested
// without a running stack. Auto-publish: there's no human step. A passing bundle moves pending ->
// proving, a failing one moves pending -> rejected (see stageAfterValidation in game-rules.ts).
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
  }): Promise<{ row: ValidationRow; stage: Stage } | null>;
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

export async function validateGame(store: Store, gameId: string): Promise<ValidateResult> {
  if (!/^[a-z0-9]{1,32}$/i.test(gameId)) return { httpStatus: 400, body: { error: 'invalid gameId' } };
  const stage = await store.gameStage(gameId);
  if (!stage) return { httpStatus: 404, body: { error: 'game not found' } };
  const bytes = await store.bundle(gameId);
  if (!bytes) return { httpStatus: 422, body: { error: 'bundle missing', gameId, stage } };

  const sha256 = await sha256Hex(bytes);
  const existing = await store.findValidation(gameId, sha256);
  if (existing) {
    // Idempotent: same bundle -> same verdict, no new row, and the stage is left untouched.
    // Re-read the stage: a concurrent run may have just applied the transition.
    return { httpStatus: 200, body: { gameId, sha256, status: existing.status, stage: await store.gameStage(gameId), validationId: existing.id, reused: true } };
  }

  const report = analyzeGame(bytes);
  const status = statusFromReport(report);
  const recorded = await store.recordValidation({ gameId, sha256, status, report, nextStage: (s) => stageAfterValidation(s, status) });
  if (!recorded) {
    const raced = await store.findValidation(gameId, sha256);
    const now = await store.gameStage(gameId);
    return { httpStatus: 200, body: { gameId, sha256, status: raced?.status, stage: now, validationId: raced?.id, reused: true } };
  }
  return {
    httpStatus: 200,
    body: {
      gameId, sha256, status, stage: recorded.stage, previousStage: stage, validationId: recorded.row.id, version: recorded.row.version, reused: false,
      level: report.status, failed: report.checks.filter((c) => c.level === 'fail').map((c) => c.id),
      warned: report.checks.filter((c) => c.level === 'warn').map((c) => c.id),
    },
  };
}
