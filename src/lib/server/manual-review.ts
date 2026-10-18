import type postgres from 'postgres';

type ReviewDb = postgres.Sql | postgres.TransactionSql;

/**
 * The manual-review switch is `private.settings.mg_manual_review`. This reads it.
 * The portal never writes the row. Missing, or anything other than `'0'`, is on,
 * matching `manual_review_enabled()` (a missing row from the function is on too).
 *
 * The client is imported only when the caller does not pass one. Unit tests and the
 * maintenance script import this module with no portal env, and config.ts throws then.
 */
export async function readManualReview(db?: ReviewDb): Promise<boolean> {
  const client = db ?? (await import('./db.ts')).sql;
  const [row] = await client<{ enabled: boolean }[]>`select public.manual_review_enabled() as enabled`;
  return row?.enabled !== false;
}
