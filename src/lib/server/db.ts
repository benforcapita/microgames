import postgres from 'postgres';
import { DATABASE_URL } from './config';

const g = globalThis as typeof globalThis & { __mgSql?: postgres.Sql };

// prepare: false keeps this compatible with Supabase's transaction pooler (port 6543).
export const sql: postgres.Sql = (g.__mgSql ??= postgres(DATABASE_URL, { prepare: false, max: 10, idle_timeout: 20 }));
