import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  insertSessionStart,
  postgresSchemaClient,
  recordGateEvent,
  resetSchemaWarnings,
  type SchemaInsertClient,
  type SchemaInsertError,
} from './schema-rollout.ts';

const SESSION = { sessionId: '11111111-1111-4111-8111-111111111111', gameId: 'game-a', userId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

function coded(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function mockSupabase(handler: (table: string, row: Record<string, unknown>) => Promise<{ error: SchemaInsertError | null }>) {
  const calls: { table: string; row: Record<string, unknown> }[] = [];
  const client: SchemaInsertClient = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.push({ table, row: { ...row } });
          return handler(table, row);
        },
      };
    },
  };
  return { client, calls };
}

describe('insertSessionStart', { concurrency: 1 }, () => {
  afterEach(() => {
    resetSchemaWarnings();
    mock.restoreAll();
  });

  it('inserts id, game, and user id on the normal path', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => ({ error: null }));
    await insertSessionStart(db.client, SESSION);
    assert.equal(db.calls.length, 1);
    assert.deepEqual(db.calls[0], {
      table: 'sessions',
      row: { id: SESSION.sessionId, game_id: SESSION.gameId, user_id: SESSION.userId },
    });
    assert.equal(warn.mock.calls.length, 0);
  });

  it('retries without user_id when Postgres says the column is missing (42703) and warns once', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async (_table, row) => {
      if ('user_id' in row) throw coded('42703', 'column "user_id" of relation "sessions" does not exist');
      return { error: null };
    });
    await insertSessionStart(db.client, SESSION);
    await insertSessionStart(db.client, { ...SESSION, userId: null });
    assert.deepEqual(db.calls.map((c) => 'user_id' in c.row), [true, false, true, false]);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /sessions\.user_id/);
  });

  it('retries without user_id when PostgREST cannot see the column (PGRST204)', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async (_table, row) => {
      if ('user_id' in row) return { error: { code: 'PGRST204', message: 'Could not find the user_id column of sessions in the schema cache' } };
      return { error: null };
    });
    await insertSessionStart(db.client, { ...SESSION, userId: null });
    assert.equal(db.calls.length, 2);
    assert.equal('user_id' in db.calls[1].row, false);
    assert.equal(db.calls[1].row.user_id, undefined);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('uses the postgres adapter: a 42703 from the user_id insert is retried without that column', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      queries.push(text);
      if (text.includes('user_id')) return Promise.reject(coded('42703'));
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql;
    await insertSessionStart(postgresSchemaClient(sql), SESSION);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /user_id/);
    assert.doesNotMatch(queries[1], /user_id/);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('does not retry a different insert error', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => ({ error: { code: '23503', message: 'insert or update violates foreign key constraint' } }));
    await assert.rejects(() => insertSessionStart(db.client, SESSION), (err: unknown) => (err as { code?: string }).code === '23503');
    assert.equal(db.calls.length, 1);
    assert.equal(warn.mock.calls.length, 0);
  });
});

describe('recordGateEvent', { concurrency: 1 }, () => {
  afterEach(() => {
    resetSchemaWarnings();
    mock.restoreAll();
  });

  it('inserts a gate event on the normal path', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => ({ error: null }));
    await recordGateEvent(db.client, { gameId: 'game-a', kind: 'shown' });
    assert.deepEqual(db.calls, [{ table: 'gate_events', row: { game_id: 'game-a', kind: 'shown' } }]);
    assert.equal(warn.mock.calls.length, 0);
  });

  it('uses the postgres adapter: a missing gate_events table does not throw', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const sql = (() => Promise.reject(coded('42P01', 'relation "gate_events" does not exist'))) as unknown as import('postgres').Sql;
    await recordGateEvent(postgresSchemaClient(sql), { gameId: 'game-a', kind: 'shown' });
    assert.equal(warn.mock.calls.length, 1);
  });

  it('skips the write when Postgres says the table is missing (42P01) and warns once', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => {
      throw coded('42P01', 'relation "gate_events" does not exist');
    });
    await recordGateEvent(db.client, { gameId: 'game-a', kind: 'signup_click' });
    await recordGateEvent(db.client, { gameId: 'game-a', kind: 'login_click' });
    assert.equal(db.calls.length, 2);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /gate_events/);
  });

  it('skips the write when PostgREST cannot see the table (PGRST205)', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => ({ error: { code: 'PGRST205', message: 'Could not find the table public.gate_events in the schema cache' } }));
    await recordGateEvent(db.client, { gameId: null, kind: 'converted' });
    assert.equal(db.calls.length, 1);
    assert.equal(warn.mock.calls.length, 1);
  });

  it('still throws when the table exists but the write fails', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const db = mockSupabase(async () => ({ error: { code: '23514', message: 'new row violates check constraint' } }));
    await assert.rejects(() => recordGateEvent(db.client, { gameId: 'game-a', kind: 'shown' }), (err: unknown) => (err as { code?: string }).code === '23514');
    assert.equal(warn.mock.calls.length, 0);
  });
});
