import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { recordScannedGameAssets, SCANNED_ASSET_COLUMNS, scannedAssetRows } from './asset-manifest.ts';

interface Captured {
  strings: string[];
  values: unknown[];
  helperRows: unknown;
  helperCols: unknown[];
}

function fakeSql(version: number) {
  const calls: Captured[] = [];
  let helperRows: unknown;
  let helperCols: unknown[] = [];
  const sql = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const captured: Captured = { strings: [...(first as string[])], values: rest, helperRows, helperCols };
      calls.push(captured);
      helperRows = undefined;
      helperCols = [];
      if (calls.length === 1) return Promise.resolve([{ version }]);
      return Promise.resolve([]);
    }
    helperRows = first;
    helperCols = rest;
    return { pending: true };
  };
  return { sql: sql as never, calls };
}

const html = (source: string) => new TextEncoder().encode(source);

describe('scanned asset insert', () => {
  test('builds missing scan rows and ignores an empty manifest', () => {
    assert.deepEqual(scannedAssetRows('game1', 3, [{ path: 'sprites/hero.png', expectedType: 'image' }]), [
      {
        game_id: 'game1',
        version: 3,
        path: 'sprites/hero.png',
        expected_type: 'image',
        status: 'missing',
        source: 'scan',
      },
    ]);
    assert.deepEqual(scannedAssetRows('game1', 1, []), []);
    assert.equal(scannedAssetRows('game1', 1, Array.from({ length: 205 }, (_, i) => ({ path: `img/${i}.png`, expectedType: 'image' as const }))).length, 200);
  });

  test('upserts source=scan status=missing for the game version and ignores conflicts', async () => {
    const db = fakeSql(4);
    await recordScannedGameAssets(db.sql, 'game1', html('<img src="./sprites/hero.png"><img src="https://cdn.example/skip.png">'));
    assert.equal(db.calls.length, 2);
    assert.match(db.calls[0].strings.join(' '), /game_validations/);
    const insert = db.calls[1];
    assert.match(insert.strings.join(' '), /insert into public\.game_assets/);
    assert.match(insert.strings.join(' '), /on conflict \(game_id, version, path\) do nothing/);
    assert.deepEqual(insert.helperCols, [...SCANNED_ASSET_COLUMNS]);
    assert.deepEqual(insert.helperRows, [
      {
        game_id: 'game1',
        version: 4,
        path: 'sprites/hero.png',
        expected_type: 'image',
        status: 'missing',
        source: 'scan',
      },
    ]);
  });

  test('does not insert when the scan finds no local assets', async () => {
    const db = fakeSql(1);
    await recordScannedGameAssets(db.sql, 'game1', html('<html><body><canvas></canvas></body></html>'));
    assert.equal(db.calls.length, 1);
  });

  test('logs and keeps the upload when the scan insert fails', async () => {
    const logs: { gameId: string; error: unknown }[] = [];
    const sql = (() => {
      throw new Error('relation "game_assets" does not exist');
    }) as never;
    await recordScannedGameAssets(sql, 'game1', html('<img src="./a.png">'), (gameId, error) => {
      logs.push({ gameId, error });
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].gameId, 'game1');
    assert.match((logs[0].error as Error).message, /game_assets/);
  });
});
