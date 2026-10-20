import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

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

async function connect(t: { skip: (message?: string) => void }): Promise<postgres.Sql | undefined> {
  const dbUrl = localDbUrl();
  if (!dbUrl) {
    t.skip('refusing to run categorization SQL against a non-local database');
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

function refused(code: string, constraint?: string) {
  return (err: unknown) =>
    err instanceof postgres.PostgresError &&
    err.code === code &&
    (constraint === undefined || err.constraint_name === constraint);
}

const gid = () => `cat1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const shaA = 'aa'.repeat(32);
const shaB = 'bb'.repeat(32);

async function insertGame(sql: Sql, id: string): Promise<void> {
  await sql`insert into public.games (id, slug, creator, title) values (${id}, ${id}, 'stub', 'CAT-1')`;
}

function insertTag(sql: Sql, gameId: string, category: string, status: string, applies: boolean | null, bundle = shaA) {
  return sql`
    insert into public.game_tags (game_id, bundle_sha256, category_slug, status, applies, confidence, model, version)
    values (${gameId}, ${bundle}, ${category}, ${status}, ${applies}, 0.9, 'jev-1.13.0', 'v1')
  `;
}

describe('categories and game_tags (CAT-1)', () => {
  it('seeds exactly two approved safety categories: nsfw 0.80/0.05 and kid_safe 0.95/0.20, with the approved wording', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const rows = await sql`
        select slug, description, status, is_safety,
               confirm_threshold::float8 as confirm_threshold,
               reject_threshold::float8 as reject_threshold
        from public.categories
        order by slug
      `;
      assert.deepEqual(
        rows.map((r) => ({ ...r })),
        [
          {
            slug: 'kid_safe',
            description:
              'suitable for ages 7+, with no realistic violence, gore, sexual content, gambling or profanity, and no open chat with strangers',
            status: 'approved',
            is_safety: true,
            confirm_threshold: 0.95,
            reject_threshold: 0.2,
          },
          {
            slug: 'nsfw',
            description: 'sexual content or nudity, graphic gore, or strong sexual themes',
            status: 'approved',
            is_safety: true,
            confirm_threshold: 0.8,
            reject_threshold: 0.05,
          },
        ],
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('a new category defaults to proposed, non-safety, 0.85/0.15', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      await rollback(sql, async (tx) => {
        await tx`insert into public.categories (slug, description) values ('gambling', 'gambling or betting')`;
        const [row] = await tx`
          select status, is_safety,
                 confirm_threshold::float8 as confirm_threshold,
                 reject_threshold::float8 as reject_threshold
          from public.categories where slug = 'gambling'
        `;
        assert.deepEqual({ ...row }, {
          status: 'proposed',
          is_safety: false,
          confirm_threshold: 0.85,
          reject_threshold: 0.15,
        });
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses a bad slug', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      await rollback(sql, async (tx) => {
        for (const slug of ['NSFW', 'bad slug', 'bad-slug', '', '_a', 'a_', 'a__b']) {
          await assert.rejects(
            tx.savepoint(
              (sp) => sp`insert into public.categories (slug, description) values (${slug}, 'x')`,
            ),
            refused('23514', 'categories_slug_check'),
            slug,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses out-of-range or inverted thresholds', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      await rollback(sql, async (tx) => {
        const bad: [string, number, number, string][] = [
          ['thr_confirm_hi', 1.5, 0.1, 'categories_confirm_threshold_range'],
          ['thr_confirm_lo', 0.1, 0.2, 'categories_thresholds_ordered'],
          ['thr_reject_lo', 0.85, -0.1, 'categories_reject_threshold_range'],
          ['thr_equal', 0.5, 0.5, 'categories_thresholds_ordered'],
          ['thr_inverted', 0.4, 0.6, 'categories_thresholds_ordered'],
        ];
        for (const [slug, confirm, reject, constraint] of bad) {
          await assert.rejects(
            tx.savepoint(
              (sp) => sp`
                insert into public.categories (slug, description, confirm_threshold, reject_threshold)
                values (${slug}, 'x', ${confirm}, ${reject})
              `,
            ),
            refused('23514', constraint),
            `${slug} ${confirm}/${reject}`,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('accepts confirmed applies=true, rejected applies=false, needs_review applies=null, appealed and overridden verdicts', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, id);
        await insertTag(tx, id, 'nsfw', 'confirmed', true);
        await insertTag(tx, id, 'kid_safe', 'rejected', false);
        const good: [string, string, boolean | null][] = [
          ['violence', 'needs_review', null],
          ['chat', 'appealed', false],
          ['gore', 'overridden', true],
        ];
        for (const [category, status, applies] of good) {
          await tx`insert into public.categories (slug, description, status) values (${category}, 'x', 'approved')`;
          await insertTag(tx, id, category, status, applies);
        }
        const rows = await tx`select status from public.game_tags where game_id = ${id}`;
        assert.equal(rows.length, 5);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses a confirmed tag with applies = false, a needs_review tag with a set applies, and other inconsistent verdicts', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, id);
        const bad: [string, boolean | null][] = [
          ['confirmed', false],
          ['confirmed', null],
          ['rejected', true],
          ['rejected', null],
          ['needs_review', true],
          ['needs_review', false],
          ['appealed', null],
          ['overridden', null],
        ];
        for (const [status, applies] of bad) {
          await assert.rejects(
            tx.savepoint((sp) => insertTag(sp, id, 'nsfw', status, applies, shaB)),
            refused('23514'),
            `${status} with applies=${applies}`,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses a short, non-hex, or uppercase bundle hash', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, id);
        const bad = ['aa'.repeat(16), 'zz'.repeat(32), 'AA'.repeat(32)];
        for (const bundle of bad) {
          await assert.rejects(
            tx.savepoint((sp) => insertTag(sp, id, 'nsfw', 'needs_review', null, bundle)),
            refused('23514', 'game_tags_bundle_sha256_check'),
            `bundle ${bundle.slice(0, 8)}…`,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses a duplicate (game, bundle, category) and a tag for an unknown category', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    const id = gid();
    try {
      await rollback(sql, async (tx) => {
        await insertGame(tx, id);
        await insertTag(tx, id, 'nsfw', 'confirmed', true);
        await assert.rejects(
          tx.savepoint((sp) => insertTag(sp, id, 'nsfw', 'needs_review', null)),
          refused('23505'),
        );
        await insertTag(tx, id, 'nsfw', 'needs_review', null, shaB);
        await assert.rejects(
          tx.savepoint((sp) => insertTag(sp, id, 'nosuch', 'confirmed', true, 'cc'.repeat(32))),
          refused('23503'),
        );
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('enables row-level security on both tables and keeps them unreadable to client roles', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const flags = await sql`
        select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname in ('categories', 'game_tags')
        order by relname
      `;
      assert.deepEqual(
        flags.map((r) => ({ ...r })),
        [
          { relname: 'categories', relrowsecurity: true },
          { relname: 'game_tags', relrowsecurity: true },
        ],
      );
      const writes: Record<string, string[]> = {
        categories: [
          `insert into public.categories (slug, description) values ('x', 'x')`,
          `update public.categories set description = 'x'`,
          `delete from public.categories`,
        ],
        game_tags: [
          `insert into public.game_tags (game_id, bundle_sha256, category_slug, status) values ('x', '${shaA}', 'nsfw', 'needs_review')`,
          `update public.game_tags set status = 'confirmed'`,
          `delete from public.game_tags`,
        ],
      };
      for (const role of ['anon', 'authenticated']) {
        for (const table of ['categories', 'game_tags']) {
          await rollback(sql, async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            for (const stmt of [`select * from public.${table}`, ...writes[table]]) {
              await assert.rejects(
                tx.savepoint((sp) => sp.unsafe(stmt)),
                refused('42501'),
                `${role}: ${stmt}`,
              );
            }
          });
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('indexes game_tags by category_slug', async (t) => {
    const sql = await connect(t);
    if (!sql) return;
    try {
      const rows = await sql`
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'game_tags'
          and indexdef like '%(category_slug%'
      `;
      assert.equal(rows.length, 1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
