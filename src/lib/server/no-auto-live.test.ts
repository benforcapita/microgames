// MG-11 static guard: no file under src/, supabase/ or admin/ may write games.stage = 'live'.
// Going live is a human decision (the table editor today, a future admin action via
// ALLOWLIST), so no request path, trigger, cron or SQL function may contain the write.
// Static regex guard — its limits are documented at the bottom of this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LIVE_STAGE_WRITE_PATTERNS } from './live-stage-writes.ts';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'supabase', 'admin'];
const SCAN_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.astro', '.sql', '.js', '.mjs', '.cjs']);

// Dependencies and generated output are never scanned.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.vercel', '.output', 'coverage']);

// Migrations are history: versions at or below the cutoff are already applied everywhere and
// cannot change. A NEW migration (any version above the cutoff) that writes 'live' IS scanned.
const MIGRATION_CUTOFF = '20261018140000';

// Tests seed live games directly to set up fixtures; they are not a runtime path.
const TEST_FILE = /(?:\.(?:test|spec)\.|_test\.)[^/\\]*$/;

// Runtime files allowed to write stage 'live'. Stays EMPTY until MGA-5 lands the admin
// promote action; then it goes here, by exact repo-relative path, with a one-line reason.
const ALLOWLIST: { file: string; reason: string }[] = [];

const PATTERNS = LIVE_STAGE_WRITE_PATTERNS;

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) stack.push(full);
      } else if (d.isFile() && SCAN_EXTS.has(path.extname(d.name))) {
        out.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

function isScanned(rel: string): boolean {
  if (TEST_FILE.test(rel)) return false;
  const migration = /^supabase\/migrations\/(\d{14})_/.exec(rel);
  if (migration && migration[1] <= MIGRATION_CUTOFF) return false;
  return !ALLOWLIST.some((entry) => entry.file === rel);
}

const allFiles = SCAN_DIRS.flatMap(walk);
const scanned = allFiles.filter(isScanned);

describe('MG-11 no-auto-live matchers', () => {
  it('flags live-stage writes', () => {
    const positive = [
      "update games set stage = 'live' where id = $1",
      "update games\n  set stage='live',\n      graduated_at = now()\n  where id = $1 and stage = 'proving'",
      "update public.games set reviewed_at = now(), stage = 'live' where id = 1",
      "on conflict (id) do update set stage = 'live'",
      "update games set (stage, graduated_at) = ('live', now()) where id = $1",
      "update public.games\n  set (graduated_at,\n       stage) = (now(),\n                'live')\n  where id = $1",
      "insert into games (id, slug, stage) values ('a','a','live')",
      "insert into public.games select *, 'live' from staging",
      ".update({ stage: 'live' }).eq('id', id)",
      ".upsert({ id, stage: 'live' })",
      ".insert({ id, stage: 'live' })",
      // plpgsql (migrations/trigger bodies): := is always an assignment, and NEW.<col> =
      // inside a trigger body assigns too — there is no comparison context to preserve.
      "new.stage := 'live'",
      "NEW.\"stage\" := 'live'",
      "new.stage = 'live'",
      "begin\n  if old.stage = 'proving' then\n    new.stage := 'live';\n  end if;\nend",
      "v_stage := 'live'",
      'update games set "stage" = \'live\' where id = 1',
    ];
    for (const sample of positive) {
      assert.ok(
        PATTERNS.some((p) => p.re.test(sample)),
        `expected a matcher to flag: ${JSON.stringify(sample)}`,
      );
    }
  });

  it('does not flag reads, comparisons, or other stages', () => {
    const negative = [
      "select * from games where stage = 'live'",
      "update games set stage = 'proving' where stage = 'live'",
      "update public.games set reviewed_at = now() where stage in ('proving', 'live')",
      "update public.games set stage = 'rejected' where id = $1 and stage = 'pending'",
      "update games set (stage, reviewed_at) = ('proving', now()) where id = $1",
      "update games set (reviewed_at, note) = (now(), 'lives here') where id = $1",
      "game.stage === 'live'",
      "const live = game.stage === 'live'",
      "and g.stage in ('proving', 'live')",
      "type Stage = 'pending' | 'proving' | 'live' | 'rejected'",
      "listGames({ stage: 'live', sort: 'top' })",
      "visibleStages({ stage, ownerId })",
      "insert into game_validations (status) values ('live')",
      "insert into games (id, slug, stage) values ($1, $2, 'proving')",
      // plpgsql comparisons that cannot be assignments: OLD is never assigned, `in` is a
      // test, and a non-'live' RHS is not a promotion.
      "old.stage = 'live'",
      "if new.stage in ('proving', 'live') then",
      "v_stage := 'proving'",
      ".select('stage').eq('stage', 'live')",
      "await sql`select stage from games where id = ${id}`",
    ];
    for (const sample of negative) {
      assert.equal(
        PATTERNS.filter((p) => p.re.test(sample)).map((p) => p.name).join(', '),
        '',
        `expected no matcher to flag: ${JSON.stringify(sample)}`,
      );
    }
  });
});

describe('MG-11 no-auto-live guard', () => {
  it('scans a non-empty tree that includes src/lib/server/games.ts and an admin source', (t) => {
    t.diagnostic(`scanned ${scanned.length} files, skipped ${allFiles.length - scanned.length}`);
    assert.ok(scanned.length > 0, 'empty scan means the glob is broken');
    assert.ok(
      scanned.includes('src/lib/server/games.ts'),
      'scan must include src/lib/server/games.ts',
    );
    assert.ok(
      scanned.includes('admin/src/lib/db.ts'),
      'scan must include admin/ sources (admin/src/lib/db.ts)',
    );
  });

  it("no scanned file writes stage = 'live'", () => {
    const hits: string[] = [];
    for (const file of scanned) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const p of PATTERNS) {
        if (p.sqlOnly && !file.endsWith('.sql')) continue;
        if (p.re.test(src)) hits.push(`${file}: ${p.name}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

// Known limits (deliberate): regex/static analysis only. It misses dynamic SQL,
// parameterised stage values (`set stage = ${x}`, `set stage = nxt`), string concatenation,
// and 'live' passed through variables or helpers. Whole-record assignment in plpgsql —
// `new := jsonb_populate_record(new, …)`, and the same via `new := row(…)`,
// `new := populate_record(…)` or `select … into new` — is missed too, by both the static
// regexes here and the catalog regexes in no-auto-live.db.test.ts: the stage write is
// smuggled inside a record value, so no stage-shaped assignment appears in the text.
// It reads src/, supabase/ and admin/, so
// scripts/ (e.g. scripts/seed.mjs — local only), e2e/, cdn/, docs/ and launch/ are not
// scanned, and DB state already on hosted Supabase is out of reach entirely
// (no-auto-live.db.test.ts checks the local catalog instead).
