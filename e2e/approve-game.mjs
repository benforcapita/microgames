// Local-stack helper. Publishes a game the way a reviewer does in the Supabase table
// editor: set stage to 'proving'. Existing specs call this after validation so a pass
// that stays pending can still be played. Refuses any database that is not loopback.
import postgres from 'postgres';
import { localSupabaseEnv } from '../scripts/lib/local-supabase.mjs';

export async function approveGame(gameId, sql) {
  const env = localSupabaseEnv();
  const host = new URL(env.DATABASE_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('approveGame only runs against the local Supabase stack');
  }
  const own = !sql;
  const db = sql ?? postgres(env.DATABASE_URL, { max: 1 });
  try {
    const rows = await db`update public.games set stage = 'proving' where id = ${gameId} returning id, stage`;
    if (!rows.length) throw new Error(`approveGame: no game ${gameId}`);
    return rows[0];
  } finally {
    if (own) await db.end({ timeout: 1 });
  }
}
