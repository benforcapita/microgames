// deno test --config supabase/functions/validate-game/deno.json --allow-read supabase/functions/validate-game/
import { assertEquals } from 'jsr:@std/assert@1';
import { stageAfterValidation, type Stage } from '../../../src/lib/server/game-rules.ts';
import { validateGame, type Store, type ValidationRow } from './validate.ts';

const FIX = new URL('../../../src/lib/server/fixtures/static-check/', import.meta.url);
const fixture = (name: string) => Deno.readFile(new URL(name, FIX));

function memStore(games: Record<string, { stage: Stage; bundle: Uint8Array | null }>) {
  const rows: (ValidationRow & { game_id: string })[] = [];
  const store: Store = {
    gameStage: async (id) => games[id]?.stage ?? null,
    bundle: async (id) => games[id]?.bundle ?? null,
    findValidation: async (id, sha) => rows.find((r) => r.game_id === id && r.bundle_sha256 === sha) ?? null,
    recordValidation: async ({ gameId, sha256, status, nextStage }) => {
      if (rows.some((r) => r.game_id === gameId && r.bundle_sha256 === sha256)) return null; // unique index
      const row = { id: crypto.randomUUID(), game_id: gameId, status, bundle_sha256: sha256, version: rows.filter((r) => r.game_id === gameId).length + 1 };
      rows.push(row);
      games[gameId].stage = nextStage(games[gameId].stage);
      return { row, stage: games[gameId].stage };
    },
    applyStoredVerdict: async (gameId, sha256) => {
      const row = rows.filter((r) => r.game_id === gameId && r.bundle_sha256 === sha256).at(-1);
      if (!games[gameId] || !row) return null;
      games[gameId].stage = stageAfterValidation(games[gameId].stage, row.status);
      return games[gameId].stage;
    },
  };
  return { store, rows, games };
}

Deno.test('every fixture: pass/warn -> proving, fail -> rejected, from pending', async () => {
  for (const entry of [...Deno.readDirSync(FIX)].sort((a, b) => a.name.localeCompare(b.name))) {
    const { store } = memStore({ g1: { stage: 'pending', bundle: await fixture(entry.name) } });
    const r = await validateGame(store, 'g1');
    const expected = entry.name.startsWith('bad-') ? 'rejected' : 'proving';
    assertEquals([entry.name, r.body.stage], [entry.name, expected]);
  }
});

Deno.test('idempotent: re-running the same bundle adds no row and never flips the stage', async () => {
  const m = memStore({ g1: { stage: 'pending', bundle: await fixture('good-minimal-canvas.html') } });
  const first = await validateGame(m.store, 'g1');
  m.games.g1.stage = 'live'; // e.g. graduated meanwhile
  const second = await validateGame(m.store, 'g1');
  assertEquals(m.rows.length, 1);
  assertEquals(second.body.reused, true);
  assertEquals(second.body.validationId, first.body.validationId);
  assertEquals(m.games.g1.stage, 'live');
});

Deno.test('a new bundle gets a new versioned row; non-pending games keep their stage', async () => {
  const m = memStore({ g1: { stage: 'pending', bundle: await fixture('good-minimal-canvas.html') } });
  await validateGame(m.store, 'g1');
  m.games.g1.bundle = await fixture('bad-remote-script.html');
  const r = await validateGame(m.store, 'g1');
  assertEquals([m.rows.length, r.body.version, r.body.status, m.games.g1.stage], [2, 2, 'failed', 'proving']);
});

Deno.test('concurrent runs on the same bundle record exactly one row', async () => {
  const m = memStore({ g1: { stage: 'pending', bundle: await fixture('bad-js-syntax.html') } });
  const rs = await Promise.all([validateGame(m.store, 'g1'), validateGame(m.store, 'g1'), validateGame(m.store, 'g1')]);
  assertEquals(m.rows.length, 1);
  assertEquals(new Set(rs.map((r) => r.body.stage)), new Set(['rejected']));
});

Deno.test('errors: bad id 400, unknown game 404, missing bundle 422 (no row)', async () => {
  const m = memStore({ g1: { stage: 'pending', bundle: null } });
  assertEquals((await validateGame(m.store, '../x')).httpStatus, 400);
  assertEquals((await validateGame(m.store, 'nope')).httpStatus, 404);
  assertEquals((await validateGame(m.store, 'g1')).httpStatus, 422);
  assertEquals([m.rows.length, m.games.g1.stage], [0, 'pending']);
});

Deno.test('stuck case: same bundle re-set to pending still moves (reused verdict, no new row)', async () => {
  for (const [fx, expected] of [['good-minimal-canvas.html', 'proving'], ['bad-remote-script.html', 'rejected']] as const) {
    const m = memStore({ g1: { stage: 'pending', bundle: await fixture(fx) } });
    const first = await validateGame(m.store, 'g1');
    assertEquals(first.body.stage, expected);
    m.games.g1.stage = 'pending'; // re-set to pending with the same bundle
    const again = await validateGame(m.store, 'g1');
    assertEquals([again.body.reused, again.body.stage, again.body.previousStage, again.body.moved], [true, expected, 'pending', true]);
    assertEquals([m.rows.length, m.games.g1.stage], [1, expected]);
    assertEquals(again.body.validationId, first.body.validationId);
  }
});

Deno.test('reused verdict on a non-pending game still never flips the stage', async () => {
  const m = memStore({ g1: { stage: 'pending', bundle: await fixture('bad-js-syntax.html') } });
  await validateGame(m.store, 'g1');
  m.games.g1.stage = 'proving'; // e.g. manually restored
  const r = await validateGame(m.store, 'g1');
  assertEquals([r.body.reused, r.body.stage, r.body.moved, m.games.g1.stage], [true, 'proving', undefined, 'proving']);
});
