import type postgres from 'postgres';
import { manualReviewEnabled } from '../manual-review';
import { sql } from './db';

type ReviewDb = postgres.Sql | postgres.TransactionSql;

/**
 * Copy `MG_MANUAL_REVIEW` into `private.settings`. The database functions read that
 * row and do not parse the env themselves. Callers that pass an explicit
 * `p_manual_review` still override it (tests).
 */
export async function writeManualReviewSetting(db: ReviewDb = sql): Promise<void> {
  const value = manualReviewEnabled() ? '1' : '0';
  await db`
    insert into private.settings (key, value)
    values ('mg_manual_review', ${value})
    on conflict (key) do update set value = excluded.value
  `;
}

let once: Promise<void> | null = null;

/** Once per process. A failed write is retried on the next call. */
export function syncManualReviewFlag(): Promise<void> {
  if (!once) {
    once = writeManualReviewSetting().then(() => undefined, (err) => {
      once = null;
      console.error('[manual-review] failed to sync MG_MANUAL_REVIEW', err instanceof Error ? err.message : err);
    });
  }
  return once;
}
