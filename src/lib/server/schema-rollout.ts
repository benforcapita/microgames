/**
 * Writes that depend on migration 20261015120200_play_gate.
 * The portal can ship before that migration: a missing column or table is skipped,
 * with one warning per process, instead of failing the request.
 */

export type GateEventKind = 'shown' | 'signup_click' | 'login_click' | 'converted';

export interface SchemaInsertError {
  code?: string;
  message?: string;
}

/** Same shape as a Supabase client's `from(table).insert(row)`. */
export interface SchemaInsertClient {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: SchemaInsertError | null }>;
  };
}

const MISSING_COLUMN = new Set(['42703', 'PGRST204']);
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

const warned = new Set<string>();

/** Test hook. Production warns at most once per process for each key. */
export function resetSchemaWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function asError(err: unknown): Error & { code?: string } {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : 'insert failed');
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function insertRow(
  client: SchemaInsertClient,
  table: string,
  row: Record<string, unknown>,
): Promise<(Error & { code?: string }) | null> {
  try {
    const result = await client.from(table).insert(row);
    if (!result?.error) return null;
    const err = new Error(result.error.message ?? result.error.code ?? 'insert failed');
    return Object.assign(err, { code: result.error.code });
  } catch (err) {
    return asError(err);
  }
}

export async function insertSessionStart(
  client: SchemaInsertClient,
  input: { sessionId: string; gameId: string; userId: string | null },
): Promise<void> {
  const withUser = await insertRow(client, 'sessions', {
    id: input.sessionId,
    game_id: input.gameId,
    user_id: input.userId,
  });
  if (!withUser) return;
  if (!MISSING_COLUMN.has(errorCode(withUser) ?? '')) throw withUser;
  warnOnce(
    'sessions.user_id',
    `[meshground] sessions.user_id is not available yet (${errorCode(withUser)}); recording session_start without a user id`,
  );
  const plain = await insertRow(client, 'sessions', { id: input.sessionId, game_id: input.gameId });
  if (plain) throw plain;
}

export async function recordGateEvent(
  client: SchemaInsertClient,
  input: { gameId: string | null; kind: GateEventKind },
): Promise<void> {
  const err = await insertRow(client, 'gate_events', { game_id: input.gameId, kind: input.kind });
  if (!err) return;
  if (!MISSING_TABLE.has(errorCode(err) ?? '')) throw err;
  warnOnce(
    'gate_events',
    `[meshground] gate_events is not available yet (${errorCode(err)}); skipping gate event`,
  );
}

/** postgres.js adapter. Throws keep their Postgres `code` (42703, 42P01, …). */
export function postgresSchemaClient(
  sql: import('postgres').Sql | import('postgres').TransactionSql,
): SchemaInsertClient {
  return {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          if (table === 'sessions') {
            const id = String(row.id);
            const gameId = String(row.game_id);
            if ('user_id' in row) {
              const userId = row.user_id == null ? null : String(row.user_id);
              const write = (db: typeof sql) => db`
                insert into sessions (id, game_id, user_id)
                values (${id}, ${gameId}, (select id from auth.users where id = ${userId}))
                on conflict (id) do update
                  set user_id = coalesce(sessions.user_id, excluded.user_id)
                  where sessions.game_id = excluded.game_id`;
              // Inside a transaction a failed statement aborts it, which would kill the
              // missing-column retry; a savepoint confines the error instead.
              if ('savepoint' in sql) await sql.savepoint(write);
              else await write(sql);
            } else {
              await sql`
                insert into sessions (id, game_id)
                values (${id}, ${gameId})
                on conflict do nothing`;
            }
            return { error: null };
          }
          if (table === 'gate_events') {
            const gameId = row.game_id == null ? null : String(row.game_id);
            await sql`
              insert into gate_events (game_id, kind)
              values (${gameId}, ${String(row.kind)})`;
            return { error: null };
          }
          throw new Error(`unsupported insert into ${table}`);
        },
      };
    },
  };
}
