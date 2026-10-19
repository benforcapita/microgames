// postgres.js client for ADMIN_DATABASE_URL plus the admin_auth_failures
// lockout store (LLD §8.2, §8.3). One lazy client per function instance:
// prepare: false for the Supabase transaction pooler, a single connection,
// short idle/connect timeouts.

import postgres from 'postgres';
import type { LockoutStore } from './auth-basic';

export function connect(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// Locked = 5+ rows with created_at inside the last 15 minutes (DB clock). The
// lock ends when the 5th newest in-window row ages out, i.e. at that row's
// created_at + 15 minutes. All timestamps are computed by the database.
export function createLockoutStore(sql: postgres.Sql): LockoutStore {
  return {
    async lockSecondsRemaining() {
      const [row] = await sql<{ remaining: number | string | null }[]>`
        with recent as (
          select created_at,
                 row_number() over (order by created_at desc) as rn
          from public.admin_auth_failures
          where created_at > now() - interval '15 minutes'
        )
        select extract(epoch from (
          max(created_at) filter (where rn = 5) + interval '15 minutes' - now()
        )) as remaining
        from recent`;
      const remaining = row?.remaining;
      return remaining === null || remaining === undefined ? 0 : Number(remaining);
    },
    async recordFailure() {
      await sql.begin(async (tx) => {
        await tx`insert into public.admin_auth_failures default values`;
        await tx`delete from public.admin_auth_failures where created_at < now() - interval '1 hour'`;
      });
    },
    async clearFailures() {
      await sql`delete from public.admin_auth_failures`;
    },
  };
}
