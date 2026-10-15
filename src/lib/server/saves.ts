import { sql } from './db';
import { MAX_SAVE_BYTES } from './config';

export type SaveData = Record<string, string>;

export async function getSave(userId: string, gameId: string): Promise<SaveData | null> {
  const [row] = await sql<{ data: SaveData }[]>`select data from saves where user_id = ${userId} and game_id = ${gameId}`;
  return row?.data ?? null;
}

export function parseSave(input: unknown): SaveData | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 500 || !entries.every(([, v]) => typeof v === 'string')) return null;
  return JSON.stringify(input).length <= MAX_SAVE_BYTES ? (input as SaveData) : null;
}

export async function putSave(userId: string, gameId: string, data: SaveData) {
  await sql`
    insert into saves (user_id, game_id, data, updated_at) values (${userId}, ${gameId}, ${sql.json(data)}, now())
    on conflict (user_id, game_id) do update set data = excluded.data, updated_at = now()`;
}
