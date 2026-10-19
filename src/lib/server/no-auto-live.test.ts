// MG-9 static guard: no file under src/ or supabase/ may write games.stage = 'live'.
// Going live is a human decision (the table editor today, a future admin action via
// ALLOWLIST), so no request path, trigger, cron or SQL function may contain the write.
// Static regex guard — its limits are documented at the bottom of this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'supabase'];
const SCAN_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.astro', '.sql', '.js', '.mjs', '.cjs']);

// Migrations are history: versions at or below the cutoff are already applied everywhere and
// cannot change. A NEW migration (any version above the cutoff) that writes 'live' IS scanned.
const MIGRATION_CUTOFF = '20261018140000';

// Tests seed live games directly to set up fixtures; they are not a runtime path.
const TEST_FILE = /(?:\.(?:test|spec)\.|_test\.)[^/\\]*$/;

// Runtime files allowed to write stage 'live'. The future admin action goes here, by exact
// repo-relative path, each entry with a one-line reason.
const ALLOWLIST: { file: string; reason: string }[] = [];

interface Pattern {
  name: string;
  re: RegExp;
}

// Each matcher targets a write shape only. Comparisons (`where stage = 'live'`,
// `game.stage === 'live'`, `stage in ('proving','live')`), type unions and read options
// (`listGames({ stage: 'live' })`) must not match — the self-test below pins that down.
const PATTERNS: Pattern[] = [
  {
    name: "SQL update … set stage = 'live'",
    // A set clause whose column list reaches stage = 'live' (first or later column). The
    // column-list shape keeps `where stage = 'live'` and `set x = '…' where stage = 'live'`
    // from matching.
    re: /\bset\s+(?:[\w.]+\s*=\s*[^,;=]+,\s*)*stage\s*=\s*'live'/i,
  },
  {
    name: "insert into games … 'live'",
    // Any literal 'live' inside an insert into the games table (column-list or select form).
    re: /\binsert\s+into\s+(?:public\.)?games\b[^;]*'live'/i,
  },
  {
    name: "supabase-js .update/.insert/.upsert({ … stage: 'live' })",
    re: /\.(?:update|insert|upsert)\s*\(\s*\{[^{}]*\bstage\s*:\s*'live'/i,
  },
];

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SCAN_EXTS.has(path.extname(d.name)))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

function isScanned(rel: string): boolean {
  if (TEST_FILE.test(rel)) return false;
  const migration = /^supabase\/migrations\/(\d{14})_/.exec(rel);
  if (migration && migration[1] <= MIGRATION_CUTOFF) return false;
  return !ALLOWLIST.some((entry) => entry.file === rel);
}

const allFiles = SCAN_DIRS.flatMap(walk);
const scanned = allFiles.filter(isScanned);

describe('MG-9 no-auto-live matchers', () => {
  it('flags live-stage writes', () => {
    const positive = [
      "update games set stage = 'live' where id = $1",
      "update games\n  set stage='live',\n      graduated_at = now()\n  where id = $1 and stage = 'proving'",
      "update public.games set reviewed_at = now(), stage = 'live' where id = 1",
      "on conflict (id) do update set stage = 'live'",
      "insert into games (id, slug, stage) values ('a','a','live')",
      "insert into public.games select *, 'live' from staging",
      ".update({ stage: 'live' }).eq('id', id)",
      ".upsert({ id, stage: 'live' })",
      ".insert({ id, stage: 'live' })",
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
      "game.stage === 'live'",
      "const live = game.stage === 'live'",
      "and g.stage in ('proving', 'live')",
      "type Stage = 'pending' | 'proving' | 'live' | 'rejected'",
      "listGames({ stage: 'live', sort: 'top' })",
      "visibleStages({ stage, ownerId })",
      "insert into game_validations (status) values ('live')",
      "insert into games (id, slug, stage) values ($1, $2, 'proving')",
      "new.stage := 'live'",
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

describe('MG-9 no-auto-live guard', () => {
  it('scans a non-empty tree that includes src/lib/server/games.ts', (t) => {
    t.diagnostic(`scanned ${scanned.length} files, skipped ${allFiles.length - scanned.length}`);
    assert.ok(scanned.length > 0, 'empty scan means the glob is broken');
    assert.ok(
      scanned.includes('src/lib/server/games.ts'),
      'scan must include src/lib/server/games.ts',
    );
  });

  it("no scanned file writes stage = 'live'", () => {
    const hits: string[] = [];
    for (const file of scanned) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const p of PATTERNS) {
        if (p.re.test(src)) hits.push(`${file}: ${p.name}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

// Known limits (deliberate): regex/static analysis only. It misses dynamic SQL,
// parameterised stage values (`set stage = ${x}`, `set stage = nxt`), string concatenation,
// and 'live' passed through variables or helpers. It only reads src/ and supabase/, so
// scripts/ (e.g. scripts/seed.mjs — local only), e2e/, cdn/, docs/ and launch/ are not
// scanned, and DB state already on hosted Supabase is out of reach entirely.
