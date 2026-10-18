// UP-4: one maintenance pass over the signed-upload pipeline — sweep `_staging` objects
// past the stale-age cutoff, then delete 'uploaded' rows whose served object is absent.
// Safe to run at any time and safe to overlap with uploads: both halves re-check before
// they remove anything (see src/lib/server/asset-maintenance.ts), object existence is
// judged in SQL over the same connection as the delete, and before a single removal the
// run refuses when a candidate list exceeds its per-run cap or when the storage canary
// shows the credential cannot see the project the database does.
//
// Server-only: needs the service key and the database URL from the deployed env
// (PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL). Local-only by default — both
// endpoints must be loopback or the run is refused before connecting; pass
// --allow-remote for a deliberate hosted run (a first hosted run should be --dry-run).
// Run on a schedule — e.g. `npm run maintenance` from a cron — more often than
// ASSET_STALE_AGE_MS so litter never gets much older than the cutoff.
//
// --dry-run lists the candidates AND runs every check a real run would — both caps and
// the storage canary — while writing nothing at all (no row deletes, no object removes,
// not even the scratch canary object). It therefore proves the key and the project
// before any real run: the report's `wouldAbort` field carries what a real run would
// refuse on. One caveat: on an EMPTY games bucket the canary has nothing to check, so
// a dry run there cannot prove key+project — it exits 3.
//
// Exit codes: 0 pass ran clean (dry or real)
//             1 refused — over a cap or the canary failed (or a removal errored);
//               a dry run that would abort exits here too, with wouldAbort set
//             2 usage error — bad flags or missing env
//             3 dry-run only — the canary could not be verified because the games
//               bucket is empty; nothing was written
//
// Flags: --dry-run (checks + candidates, zero writes), --allow-remote,
//        --max-orphans N (default 20), --max-staging N (default 200),
//        --storage-timeout-ms N (default 15000).
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import {
  MAINTENANCE_MAX_ORPHAN_DELETES,
  MAINTENANCE_MAX_STAGING_REMOVES,
  MAINTENANCE_STORAGE_TIMEOUT_MS,
  maintenanceFetch,
  maintenanceRemoteRefusal,
  maintenanceStorage,
  runAssetMaintenance,
} from '../src/lib/server/asset-maintenance.ts';

const USAGE = `asset-maintenance: sweep stale _staging objects and delete orphaned asset rows
  --dry-run              report candidates and run the caps + canary, writing nothing
                         (exits 1 when a real run would abort, 3 when the canary cannot
                         be verified on an empty bucket, 0 when all checks pass)
  --allow-remote         permit non-loopback PUBLIC_SUPABASE_URL / DATABASE_URL
  --max-orphans N        refuse when more than N orphan rows are candidates (default ${MAINTENANCE_MAX_ORPHAN_DELETES})
  --max-staging N        refuse when more than N stale staging objects are candidates (default ${MAINTENANCE_MAX_STAGING_REMOVES})
  --storage-timeout-ms N abort any Storage call that outlives N ms (default ${MAINTENANCE_STORAGE_TIMEOUT_MS})`;

let args;
try {
  args = parseArgs({
    args: process.argv.slice(2),
    options: {
      'dry-run': { type: 'boolean', default: false },
      'allow-remote': { type: 'boolean', default: false },
      'max-orphans': { type: 'string' },
      'max-staging': { type: 'string' },
      'storage-timeout-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
} catch (error) {
  console.error(`asset-maintenance: ${error instanceof Error ? error.message : error}\n${USAGE}`);
  process.exit(2);
}
if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}

const intFlag = (name, fallback) => {
  const raw = args.values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`asset-maintenance: --${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
};

const maxOrphans = intFlag('max-orphans', MAINTENANCE_MAX_ORPHAN_DELETES);
const maxStaging = intFlag('max-staging', MAINTENANCE_MAX_STAGING_REMOVES);
const storageTimeoutMs = intFlag('storage-timeout-ms', MAINTENANCE_STORAGE_TIMEOUT_MS);

// Env is validated here, before anything connects or any module that reads env is
// imported — this file deliberately does not import config.ts (its import-time throw
// would mask this check, which is exactly the dead-code bug QA #79 S1 reported).
const REQUIRED_ENV = ['PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DATABASE_URL'];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`asset-maintenance: missing env ${missing.join(', ')} (see .env.example)`);
  process.exit(2);
}

// Local-only by default: refuse remote targets before any connection is attempted.
if (!args.values['allow-remote']) {
  const refusal = maintenanceRemoteRefusal({
    supabaseUrl: process.env.PUBLIC_SUPABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
  });
  if (refusal) {
    console.error(`asset-maintenance: ${refusal}`);
    process.exit(1);
  }
}

// The games bucket — same literal as bucket_id='games' in asset-maintenance.ts's SQL and
// GAMES_BUCKET in config.ts (not imported here: see the env note above).
const games = createClient(process.env.PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
  global: { fetch: maintenanceFetch(storageTimeoutMs) },
}).storage.from('games');
const storage = maintenanceStorage(games);

const sql = postgres(process.env.DATABASE_URL, { max: 2, connect_timeout: 10 });
try {
  const report = await runAssetMaintenance(sql, storage, {
    dryRun: args.values['dry-run'],
    maxOrphanDeletes: maxOrphans,
    maxStagingRemoves: maxStaging,
  });
  console.log(`asset-maintenance${report.dryRun ? ' (dry run — nothing deleted)' : ''}: ${JSON.stringify(report)}`);
  if (report.errors.length) process.exitCode = 1;
  if (report.canaryUnverified) process.exitCode = 3;
  else if (report.wouldAbort) process.exitCode = 1;
} catch (error) {
  console.error(`asset-maintenance: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
