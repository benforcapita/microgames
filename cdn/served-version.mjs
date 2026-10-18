/**
 * Which bundle version the CDN should serve.
 *
 * Owner preview (a pending/rejected game opened by its owner) gets the latest version.
 * A game that has been reviewed keeps the newest passed version finished at or before
 * `reviewedAt`, so a later upload does not replace the live one.
 * Rows with no `reviewedAt` (games that already existed, no backfill) keep the latest version.
 *
 * @param {{ preview?: boolean, reviewedAt?: string | null, rows?: { version?: unknown, status?: unknown, finished_at?: unknown, finishedAt?: unknown }[] }} input
 */
export function servedBundleVersion({ preview, reviewedAt, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  const latest = latestVersion(list);
  if (preview || !reviewedAt) return latest;
  const cutoff = Date.parse(reviewedAt);
  if (Number.isNaN(cutoff)) return latest;
  let approved = 0;
  for (const row of list) {
    if (row?.status !== 'passed') continue;
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) continue;
    const finished = Date.parse(String(row.finished_at ?? row.finishedAt ?? ''));
    if (Number.isNaN(finished) || finished > cutoff) continue;
    if (version > approved) approved = version;
  }
  return approved >= 1 ? approved : latest;
}

function latestVersion(rows) {
  let latest = 1;
  for (const row of rows) {
    const version = Number(row?.version);
    if (Number.isSafeInteger(version) && version > latest) latest = version;
  }
  return latest;
}
