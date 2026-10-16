/**
 * Writes scan rows for one game version. Conflicts stay as they are:
 * a later scan must not flip an uploaded or rejected row back to missing.
 */
import type postgres from 'postgres';
import { MAX_ASSETS_PER_GAME, scanAssetSource, type ExpectedType, type ScannedAsset } from './asset-scan';

export type AssetDb = postgres.Sql | postgres.TransactionSql;

export interface ScannedAssetRow {
  game_id: string;
  version: number;
  path: string;
  expected_type: ExpectedType;
  status: 'missing';
  source: 'scan';
}

export const SCANNED_ASSET_COLUMNS = ['game_id', 'version', 'path', 'expected_type', 'status', 'source'] as const;

export function scannedAssetRows(gameId: string, version: number, assets: ScannedAsset[]): ScannedAssetRow[] {
  return assets.slice(0, MAX_ASSETS_PER_GAME).map((asset) => ({
    game_id: gameId,
    version,
    path: asset.path,
    expected_type: asset.expectedType,
    status: 'missing',
    source: 'scan',
  }));
}

export async function gameBundleVersion(sql: AssetDb, gameId: string): Promise<number> {
  const [row] = await sql<{ version: number }[]>`
    select coalesce(max(version), 1)::int as version
    from public.game_validations
    where game_id = ${gameId}
  `;
  return row?.version ?? 1;
}

/** Insert manifest rows. `on conflict do nothing` leaves an existing path untouched. */
export async function upsertScannedAssetsSql(sql: AssetDb, gameId: string, version: number, assets: ScannedAsset[]): Promise<void> {
  const rows = scannedAssetRows(gameId, version, assets);
  if (rows.length === 0) return;
  await sql`
    insert into public.game_assets ${sql(rows, ...SCANNED_ASSET_COLUMNS)}
    on conflict (game_id, version, path) do nothing
  `;
}

export function logAssetScanFailure(gameId: string, error: unknown): void {
  try {
    console.error(`Asset scan failed for game ${gameId}; upload kept`, error);
  } catch {
    // A broken logger must not fail the upload.
  }
}

/**
 * Scan the uploaded HTML and upsert `source = 'scan'`, `status = 'missing'` rows
 * for this game version. A scan or insert failure is logged and swallowed.
 */
export async function recordScannedGameAssets(
  sql: AssetDb,
  gameId: string,
  html: Uint8Array,
  log: (gameId: string, error: unknown) => void = logAssetScanFailure,
): Promise<void> {
  try {
    const version = await gameBundleVersion(sql, gameId);
    const source = new TextDecoder('utf-8', { fatal: false }).decode(html);
    await upsertScannedAssetsSql(sql, gameId, version, scanAssetSource(source, 'html').assets);
  } catch (error) {
    log(gameId, error);
  }
}
