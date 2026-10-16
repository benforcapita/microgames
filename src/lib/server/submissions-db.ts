/**
 * Postgres access for submission status.
 *
 * `game_validations` is on main (SP-3). The query uses the shared columns:
 * id, game_id, version, status, static_report, run_report, screenshot_paths,
 * created_at, finished_at. SP-5 does not insert a row here. EF-2's trigger
 * enqueues validate-game on the pending insert, and EF-1 writes the verdict.
 * `bundle_sha256` is written by the validator. A missing relation is a real error.
 */
import type { Stage } from './game-rules';
import { sql } from './db';
import { asValidationStatus, coerceQueuedStaticReport, preferValidation, type SubmissionStore, type ValidationRow } from './submissions';
import { gameBundleVersion, type AssetDb } from './asset-manifest';

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
    const rows = await sql<ValidationHit[]>`
      select id, game_id, version, status, static_report, run_report, screenshot_paths, created_at, finished_at
      from game_validations
      where game_id = ${gameId}
      order by created_at desc
      limit 8`;
    return preferValidation(rows.flatMap((row) => {
      const mapped = mapValidation(row);
      return mapped ? [mapped] : [];
    }));
  },
};

function mapValidation(row: ValidationHit): ValidationRow | null {
  const status = asValidationStatus(row.status);
  if (!status) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    version: row.version,
    status,
    staticReport: status === 'queued' ? coerceQueuedStaticReport(row.static_report) : row.static_report,
    runReport: row.run_report,
    screenshotPaths: row.screenshot_paths ?? [],
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

interface AssetDbRow {
  path: string;
  status: string;
  size_bytes: number | null;
}

function isAssetStatus(status: unknown): status is 'missing' | 'uploaded' | 'rejected' {
  return status === 'missing' || status === 'uploaded' || status === 'rejected';
}

export async function loadAssetSummaryInput(
  gameId: string,
  sqlClient: AssetDb = sql,
): Promise<{
  codeBytes: number;
  assets: { path: string; status: 'missing' | 'uploaded' | 'rejected'; sizeBytes: number | null }[];
}> {
  const version = await gameBundleVersion(sqlClient, gameId);
  const [gameRow] = await sqlClient<{ size_bytes: number | null }[]>`
    select size_bytes from games where id = ${gameId}
  `;
  const assetRows = await sqlClient<AssetDbRow[]>`
    select path, status, size_bytes
    from game_assets
    where game_id = ${gameId} and version = ${version}
    order by created_at, id
  `;
  const assets: { path: string; status: 'missing' | 'uploaded' | 'rejected'; sizeBytes: number | null }[] = [];
  for (const row of assetRows) {
    if (isAssetStatus(row.status)) {
      assets.push({
        path: row.path,
        status: row.status,
        sizeBytes: typeof row.size_bytes === 'number' ? row.size_bytes : null,
      });
    }
  }
  return {
    codeBytes: typeof gameRow?.size_bytes === 'number' ? gameRow.size_bytes : 0,
    assets,
  };
}
