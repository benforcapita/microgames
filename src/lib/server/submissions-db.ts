/**
 * Postgres access for submission status.
 *
 * `game_validations` is not on main. The query uses the columns shared by the
 * Features v2 spec and the SP-3 draft: id, game_id, version, status,
 * static_report, run_report, screenshot_paths, created_at, finished_at.
 * SP-3 also adds `bundle_sha256` and does not add `gh_run_id`; neither is read here.
 * A missing table surfaces as a placeholder from `readSubmission`.
 */
import type { Stage } from './game-rules';
import { sql } from './db';
import { asValidationStatus, type SubmissionStore, type ValidationRow, type QueuedStaticReport } from './submissions';

interface GameHit {
  id: string;
  slug: string;
  title: string;
  owner_id: string | null;
  stage: Stage;
}

interface ValidationHit {
  id: string;
  game_id: string;
  version: number;
  status: string;
  static_report: unknown;
  run_report: unknown;
  screenshot_paths: string[] | null;
  created_at: Date;
  finished_at: Date | null;
}

export const sqlSubmissionStore: SubmissionStore = {
  async getGame(id) {
    const [row] = await sql<GameHit[]>`
      select id, slug, title, owner_id, stage from games where id = ${id}`;
    if (!row) return null;
    return { id: row.id, slug: row.slug, title: row.title, ownerId: row.owner_id, stage: row.stage };
  },
  async latestValidation(gameId) {
    const [row] = await sql<ValidationHit[]>`
      select id, game_id, version, status, static_report, run_report, screenshot_paths, created_at, finished_at
      from game_validations
      where game_id = ${gameId}
      order by created_at desc
      limit 1`;
    return row ? mapValidation(row) : null;
  },
};

export async function enqueueValidation(gameId: string, report: QueuedStaticReport): Promise<void> {
  await sql`
    insert into game_validations (game_id, version, status, static_report)
    values (${gameId}, 1, 'queued', ${sql.json(report as never)})`;
}

function mapValidation(row: ValidationHit): ValidationRow | null {
  const status = asValidationStatus(row.status);
  if (!status) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    version: row.version,
    status,
    staticReport: row.static_report,
    runReport: row.run_report,
    screenshotPaths: row.screenshot_paths ?? [],
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
