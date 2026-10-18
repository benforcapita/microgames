// UP-4: one maintenance pass over the signed-upload pipeline — sweep `_staging` objects
// past the stale-age cutoff, then delete 'uploaded' rows whose served object is absent.
// Safe to run at any time and safe to overlap with uploads: both halves re-check before
// they remove anything (see src/lib/server/asset-maintenance.ts).
//
// Server-only: needs the service key and the database URL from the deployed env
// (PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL). Run on a schedule — e.g.
// `npm run maintenance` from a cron — and schedule it more often than ASSET_STALE_AGE_MS
// so litter never gets much older than the cutoff.
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { runAssetMaintenance } from '../src/lib/server/asset-maintenance.ts';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`asset-maintenance: missing env ${name}`);
    process.exit(2);
  }
  return value;
};

const games = createClient(required('PUBLIC_SUPABASE_URL'), required('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false },
}).storage.from('games');

const storage = {
  exists: async (path) => (await games.exists(path)).data === true,
  remove: async (paths) => {
    const res = await games.remove(paths);
    return { error: res.error ? { message: res.error.message } : null };
  },
};

const sql = postgres(required('DATABASE_URL'), { max: 2 });
try {
  const report = await runAssetMaintenance(sql, storage);
  console.log(`asset-maintenance: ${JSON.stringify(report)}`);
  if (report.errors.length) process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
