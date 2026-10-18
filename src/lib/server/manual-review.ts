import type postgres from 'postgres';
import { sql } from './db';

type ReviewDb = postgres.Sql | postgres.TransactionSql;

/**
 * The manual-review switch is `private.settings.mg_manual_review`. This reads it.
 * The portal never writes the row. Missing, or anything other than `'0'`, is on,
 * matching `manual_review_enabled()` (a missing row from the function is on too).
 */
export async function readManualReview(db: ReviewDb = sql): Promise<boolean> {
  const [row] = await db<{ enabled: boolean }[]>`select public.manual_review_enabled() as enabled`;
  return row?.enabled !== false;
}
