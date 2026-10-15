// Reads the LOCAL Supabase stack's connection info from `supabase status` at runtime and maps it onto the
// app's env var names. Nothing is written to disk. Refuses anything that isn't a loopback stack, so tests
// can never point at a hosted / remote project.
import { execFileSync } from 'node:child_process';

const CLI = ['-y', 'supabase@2.120.0'];

export function localSupabaseEnv() {
  let out;
  try {
    out = execFileSync('npx', [...CLI, 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error('Local Supabase stack is not running. Start it with `npm run db:start` (needs Docker).');
  }
  const s = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  const local = (u) => /^(http|postgresql):\/\/([^@/]*@)?(127\.0\.0\.1|localhost)[:/]/.test(u ?? '');
  if (!local(s.API_URL) || !local(s.DB_URL)) throw new Error(`Refusing non-local Supabase (${s.API_URL})`);
  return {
    PUBLIC_SUPABASE_URL: s.API_URL,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY ?? s.ANON_KEY,
    SUPABASE_SECRET_KEY: s.SECRET_KEY ?? s.SERVICE_ROLE_KEY,
    DATABASE_URL: s.DB_URL,
    MAILPIT_URL: s.MAILPIT_URL ?? s.INBUCKET_URL,
  };
}
