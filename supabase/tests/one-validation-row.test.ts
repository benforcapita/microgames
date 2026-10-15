import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const cleanupSql = readFileSync(join(supabaseDir, 'ops', 'cleanup_stale_queued_validations.sql'), 'utf8');
const migrationsDir = join(supabaseDir, 'migrations');

type Sql = postgres.Sql | postgres.TransactionSql;

function statements(file: string): string[] {
  return file
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^(begin|commit|rollback)$/i.test(part));
}

function localDbUrl(): string | undefined {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  try {
    const host = new URL(raw).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') return undefined;
  } catch {
    return undefined;
  }
  return raw;
}

function gameId(label: string): string {
  return `sp5b-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const shaA = '11'.repeat(32);
const shaB = '22'.repeat(32);

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run validation SQL against a non-local database');
    return undefined;
  }
  const sql = postgres(dbUrl, { connect_timeout: 3, max: 1, idle_timeout: 1 });
  try {
    await sql`select 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    t.skip('local supabase is not running');
    return undefined;
  }
}

async function rollback(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  let rolledBack = false;
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      rolledBack = true;
      throw new Error('ROLLBACK');
    });
  } catch (err) {
    if (!rolledBack || !(err instanceof Error) || err.message !== 'ROLLBACK') throw err;
  }
}

async function insertPending(sql: Sql, id: string): Promise<void> {
  await sql`
    insert into public.games (id, slug, creator, title, stage)
    values (${id}, ${id}, 'stub', 'SP-5b', 'pending')
  `;
}

describe('one game_validations row per attempt', () => {
  it('the supersede migration sorts after the input_support update and keeps that write', () => {
    const names = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
    assert.equal(names.includes('20261015140100_supersede_queued_validation.sql'), false);
    assert.ok(names.includes('20261015150000_record_input_support.sql'));
    const supersede = names.filter((name) => name.includes('supersede_queued_validation'));
    assert.deepEqual(supersede, ['20261015160000_supersede_queued_validation.sql']);
    assert.ok('20261015160000_supersede_queued_validation.sql' > '20261015150000_record_input_support.sql');
    const body = readFileSync(join(migrationsDir, '20261015160000_supersede_queued_validation.sql'), 'utf8');
    assert.match(body, /input_support = p_report->'inputSupport'->>'class'/);
    assert.match(body, /status = 'queued'/);
    assert.match(body, /bundle_sha256 is null/);
  });

  it('a pending insert does not write a validation row', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('insert');
    try {
      await rollback(sql, async (tx) => {
        await insertPending(tx, id);
        const rows = await tx`select id from public.game_validations where game_id = ${id}`;
        assert.equal(rows.length, 0);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('records a single verdict when no placeholder exists, and a second call does not add a row', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('fresh');
    try {
      await rollback(sql, async (tx) => {
        await insertPending(tx, id);
        const [first] = await tx<{ status: string; version: number; stage: string }[]>`
          select status, version, stage
          from public.record_game_validation(${id}, ${shaA}, 'passed', ${tx.json({ status: 'pass', checks: [] })})
        `;
        assert.equal(first?.status, 'passed');
        assert.equal(first?.version, 1);
        assert.equal(first?.stage, 'proving');

        const again = await tx`
          select id from public.record_game_validation(${id}, ${shaA}, 'passed', ${tx.json({ status: 'pass', checks: [] })})
        `;
        assert.equal(again.length, 0);
        const rows = await tx`select status, version from public.game_validations where game_id = ${id}`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'passed');
        assert.equal(rows[0].version, 1);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('supersedes a queued placeholder instead of inserting version 2', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('queued');
    try {
      await rollback(sql, async (tx) => {
        await insertPending(tx, id);
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${id}, 1, 'queued', ${tx.json({ status: 'pass', bytes: 12, checks: [] })}, now() - interval '2 seconds')
        `;
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${id}, 2, 'queued', ${tx.json({ status: 'pass', checks: [] })}, now())
        `;

        const [row] = await tx<{ status: string; version: number; stage: string }[]>`
          select status, version, stage
          from public.record_game_validation(
            ${id},
            ${shaB},
            'failed',
            ${tx.json({ status: 'fail', checks: [{ id: 'size', level: 'fail' }] })}
          )
        `;
        assert.equal(row?.status, 'failed');
        assert.equal(row?.version, 2);
        assert.equal(row?.stage, 'rejected');

        const left = await tx<{ status: string; version: number; report_status: string | null }[]>`
          select status, version, static_report->>'status' as report_status
          from public.game_validations
          where game_id = ${id}
          order by version
        `;
        assert.equal(left.length, 1);
        assert.equal(left[0].status, 'failed');
        assert.equal(left[0].report_status, 'fail');
        assert.notEqual(left[0].report_status, 'pass');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('updates input_support and supersedes the queued row in the same call', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gameId('both');
    try {
      await rollback(sql, async (tx) => {
        await insertPending(tx, id);
        const [queued] = await tx<{ id: string }[]>`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${id}, 1, 'queued', ${tx.json({ status: 'pass', bytes: 12, checks: [] })}, now() - interval '2 seconds')
          returning id
        `;
        const [before] = await tx<{ input_support: string }[]>`
          select input_support from public.games where id = ${id}
        `;
        assert.equal(before?.input_support, 'unknown');

        const [row] = await tx<{ id: string; status: string; version: number; stage: string }[]>`
          select id, status, version, stage
          from public.record_game_validation(
            ${id},
            ${shaA},
            'passed',
            ${tx.json({ status: 'pass', checks: [], inputSupport: { class: 'mobile' } })}
          )
        `;
        assert.equal(row?.id, queued?.id);
        assert.equal(row?.status, 'passed');
        assert.equal(row?.version, 1);
        assert.equal(row?.stage, 'proving');

        const left = await tx<{ id: string; status: string; version: number; bundle_sha256: string | null }[]>`
          select id, status, version, bundle_sha256
          from public.game_validations
          where game_id = ${id}
        `;
        assert.equal(left.length, 1);
        assert.equal(left[0].id, queued?.id);
        assert.equal(left[0].status, 'passed');
        assert.equal(left[0].version, 1);
        assert.equal(left[0].bundle_sha256, shaA);

        const [game] = await tx<{ input_support: string; stage: string }[]>`
          select input_support, stage from public.games where id = ${id}
        `;
        assert.equal(game?.input_support, 'mobile');
        assert.equal(game?.stage, 'proving');
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('cleanup drops a stale queued row beside a later verdict and strips a lone fake pass', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const paired = gameId('paired');
    const lone = gameId('lone');
    const newerQueued = gameId('newerq');
    const running = gameId('running');
    try {
      await rollback(sql, async (tx) => {
        await insertPending(tx, paired);
        await insertPending(tx, lone);
        await insertPending(tx, newerQueued);
        await insertPending(tx, running);
        const t0 = new Date('2026-10-15T09:00:00.000Z');
        const t1 = new Date('2026-10-15T09:05:00.000Z');
        const t2 = new Date('2026-10-15T09:10:00.000Z');
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${paired}, 1, 'queued', ${tx.json({ status: 'pass', checks: [] })}, ${t0})
        `;
        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status, static_report, finished_at, created_at)
          values (${paired}, 2, ${shaA}, 'passed', ${tx.json({ status: 'pass', checks: [] })}, now(), ${t1})
        `;
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${lone}, 1, 'queued', ${tx.json({ status: 'pass', checks: [] })}, ${t0})
        `;
        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status, static_report, finished_at, created_at)
          values (${newerQueued}, 1, ${shaB}, 'passed', ${tx.json({ status: 'pass', checks: [] })}, now(), ${t0})
        `;
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${newerQueued}, 2, 'queued', ${tx.json({ status: 'pass', checks: [] })}, ${t1})
        `;
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${running}, 1, 'queued', ${tx.json({ status: 'queued' })}, ${t0})
        `;
        await tx`
          insert into public.game_validations (game_id, version, bundle_sha256, status, static_report, finished_at, created_at)
          values (${running}, 2, ${shaA}, 'passed', ${tx.json({ status: 'pass', checks: [] })}, now(), ${t1})
        `;
        await tx`
          insert into public.game_validations (game_id, version, status, static_report, created_at)
          values (${running}, 3, 'running', '{}'::jsonb, ${t2})
        `;

        const runnable = statements(cleanupSql);
        assert.ok(runnable.some((statement) => /^select count\(\*\)/i.test(statement)));
        assert.match(cleanupSql, /\bbegin\s*;/i);
        assert.match(cleanupSql, /\bcommit\s*;/i);
        for (const statement of runnable) await tx.unsafe(statement);

        const pairedRows = await tx<{ status: string; version: number }[]>`
          select status, version from public.game_validations where game_id = ${paired} order by version
        `;
        assert.equal(pairedRows.length, 1);
        assert.equal(pairedRows[0].status, 'passed');
        assert.equal(pairedRows[0].version, 2);

        const [loneRow] = await tx<{ status: string; report_status: string | null }[]>`
          select status, static_report->>'status' as report_status
          from public.game_validations where game_id = ${lone}
        `;
        assert.equal(loneRow?.status, 'queued');
        assert.equal(loneRow?.report_status, 'queued');

        const newerRows = await tx<{ status: string }[]>`
          select status from public.game_validations where game_id = ${newerQueued} order by version
        `;
        assert.deepEqual(newerRows.map((row) => row.status), ['passed', 'queued']);

        const runningRows = await tx<{ status: string }[]>`
          select status from public.game_validations where game_id = ${running} order by version
        `;
        assert.deepEqual(runningRows.map((row) => row.status), ['queued', 'passed', 'running']);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
