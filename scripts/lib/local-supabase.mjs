// Reads the LOCAL Supabase stack's connection info from `supabase status` at runtime and maps it onto the
// app's env var names. Nothing is written to disk. Refuses anything that isn't a loopback stack, so tests
// can never point at a hosted / remote project.
import { execFileSync } from 'node:child_process';

const CLI = ['-y', 'supabase@2.120.0'];

const local = (u) => /^(http|postgresql):\/\/([^@/]*@)?(127\.0\.0\.1|localhost)[:/]/.test(u ?? '');

/** Loopback env already in the process, used when `supabase status` is unavailable. Never accepts a hosted URL. */
function loopbackProcessEnv() {
  const url = process.env.PUBLIC_SUPABASE_URL;
  const db = process.env.DATABASE_URL;
  const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!local(url) || !local(db) || !key || !secret) return null;
  return {
    PUBLIC_SUPABASE_URL: url,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
    SUPABASE_SECRET_KEY: secret,
    DATABASE_URL: db,
    MAILPIT_URL: process.env.MAILPIT_URL,
  };
}

export function localSupabaseEnv() {
  let out;
  try {
    // When a loopback process env is already set, don't wait on a cold `npx supabase` download.
    const timeout = loopbackProcessEnv() ? 8_000 : undefined;
    out = execFileSync('npx', [...CLI, 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout });
  } catch {
    const fallback = loopbackProcessEnv();
    if (fallback) return fallback;
    throw new Error('Local Supabase stack is not running. Start it with `npm run db:start` (needs Docker).');
  }
  const s = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  if (!local(s.API_URL) || !local(s.DB_URL)) throw new Error(`Refusing non-local Supabase (${s.API_URL})`);
  return {
    PUBLIC_SUPABASE_URL: s.API_URL,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY ?? s.ANON_KEY,
    SUPABASE_SECRET_KEY: s.SECRET_KEY ?? s.SERVICE_ROLE_KEY,
    DATABASE_URL: s.DB_URL,
    MAILPIT_URL: s.MAILPIT_URL ?? s.INBUCKET_URL,
  };
}
