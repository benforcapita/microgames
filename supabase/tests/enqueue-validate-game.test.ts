import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import postgres from 'postgres';

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const reason = 'validation unavailable, please re-upload';

describe('pending insert calls validate-game', () => {
  it('queues {gameId, reason} and the vault hook header', async (t) => {
    const sql = postgres(dbUrl, { connect_timeout: 3, max: 1, idle_timeout: 1 });
    const id = `ef2-hook-${Date.now().toString(36)}`;
    try {
      await sql`select 1`;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      t.skip('local supabase is not running');
      return;
    }

    let rolledBack = false;
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into public.games (id, slug, creator, title, stage)
          values (${id}, ${id}, 'stub', 'Hook body', 'pending')
        `;
        const [req] = await tx<{ body: string; headers: Record<string, string> }[]>`
          select convert_from(body, 'UTF8') as body, headers
          from net.http_request_queue
          where position(${id} in convert_from(body, 'UTF8')) > 0
          order by id desc
          limit 1
        `;
        assert.ok(req, 'expected a queued validate-game request');
        assert.deepEqual(JSON.parse(req.body), { gameId: id, reason: 'stage_pending' });

        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), value]),
        );
        const [secret] = await tx<{ decrypted_secret: string }[]>`
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'validate_game_hook_secret'
        `;
        assert.ok(secret?.decrypted_secret);
        assert.equal(headers['x-meshgrounds-hook'], secret.decrypted_secret);
        assert.equal(headers['content-type'], 'application/json');
        rolledBack = true;
        throw new Error('ROLLBACK');
      });
    } catch (err) {
      if (!rolledBack || !(err instanceof Error) || err.message !== 'ROLLBACK') throw err;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe('sweep rejects a pending game after 8 attempts', () => {
  it('sets stage=rejected and writes the game_validations row SP-5 reads', async (t) => {
    const sql = postgres(dbUrl, { connect_timeout: 3, max: 1, idle_timeout: 1 });
    const id = `ef2-${Date.now().toString(36)}`;
    try {
      await sql`select 1`;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      t.skip('local supabase is not running');
      return;
    }

    try {
      const [cap] = await sql<{ value: string }[]>`
        select value from private.settings where key = 'validate_game_max_attempts'
      `;
      assert.equal(cap?.value, '8');

      await sql`
        insert into public.games (id, slug, creator, title, stage)
        values (${id}, ${id}, 'stub', 'Stuck pending', 'pending')
      `;
      await sql`
        insert into private.validation_dispatch (game_id, attempts, last_dispatched_at, last_reason)
        values (${id}, 8, now() - interval '10 minutes', 'test')
        on conflict (game_id) do update
          set attempts = 8,
              last_dispatched_at = now() - interval '10 minutes'
      `;

      await sql`select private.sweep_stuck_pending_games()`;

      const [game] = await sql<{ stage: string }[]>`
        select stage from public.games where id = ${id}
      `;
      assert.equal(game?.stage, 'rejected');

      const rows = await sql<{ status: string; reason: string | null }[]>`
        select status, static_report->>'reason' as reason
        from public.game_validations
        where game_id = ${id}
        order by created_at desc
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'error');
      assert.equal(rows[0].reason, reason);
    } finally {
      await sql`delete from public.games where id = ${id}`.catch(() => {});
      await sql.end({ timeout: 1 });
    }
  });
});
