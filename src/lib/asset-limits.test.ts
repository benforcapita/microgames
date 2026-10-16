import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASSET_SIZE_WARN_BYTES,
  GAME_VERSION_MAX_BYTES,
  formatSize,
  summarizeAssets,
} from './asset-limits';

describe('summarizeAssets behavior', () => {
  it('one missing file is listed', () => {
    const summary = summarizeAssets({
      codeBytes: 10_000,
      assets: [{ path: 'audio/bgm.mp3', status: 'missing', sizeBytes: null }],
    });

    assert.deepEqual(summary.missing, ['audio/bgm.mp3']);
  });

  it('lists missing files in input order', () => {
    const summary = summarizeAssets({
      codeBytes: 5_000,
      assets: [
        { path: 'sprites/player.png', status: 'missing', sizeBytes: null },
        { path: 'sprites/enemy.png', status: 'uploaded', sizeBytes: 20_000 },
        { path: 'audio/jump.wav', status: 'missing', sizeBytes: null },
        { path: 'data/levels.json', status: 'missing', sizeBytes: null },
      ],
    });

    assert.deepEqual(summary.missing, [
      'sprites/player.png',
      'audio/jump.wav',
      'data/levels.json',
    ]);
  });

  it('total counts code + uploaded only', () => {
    const summary = summarizeAssets({
      codeBytes: 50_000,
      assets: [
        { path: 'textures/floor.png', status: 'uploaded', sizeBytes: 150_000 },
        { path: 'audio/music.ogg', status: 'missing', sizeBytes: 300_000 },
        { path: 'models/hero.glb', status: 'rejected', sizeBytes: 800_000 },
      ],
    });

    assert.equal(summary.totalBytes, 200_000);
  });

  it('exactly 4 MB is not over, 4 MB + 1 is over', () => {
    const exact = summarizeAssets({
      codeBytes: GAME_VERSION_MAX_BYTES,
      assets: [],
    });
    assert.equal(exact.totalBytes, 4 * 1024 * 1024);
    assert.equal(exact.overTotal, false);

    const exactWithAssets = summarizeAssets({
      codeBytes: 1024 * 1024,
      assets: [
        { path: 'asset1.png', status: 'uploaded', sizeBytes: 3 * 1024 * 1024 },
      ],
    });
    assert.equal(exactWithAssets.totalBytes, 4 * 1024 * 1024);
    assert.equal(exactWithAssets.overTotal, false);

    const overByOne = summarizeAssets({
      codeBytes: GAME_VERSION_MAX_BYTES + 1,
      assets: [],
    });
    assert.equal(overByOne.totalBytes, 4 * 1024 * 1024 + 1);
    assert.equal(overByOne.overTotal, true);

    const overByOneWithAssets = summarizeAssets({
      codeBytes: 1024 * 1024,
      assets: [
        { path: 'asset1.png', status: 'uploaded', sizeBytes: 3 * 1024 * 1024 + 1 },
      ],
    });
    assert.equal(overByOneWithAssets.totalBytes, 4 * 1024 * 1024 + 1);
    assert.equal(overByOneWithAssets.overTotal, true);
  });

  it('100 KB is not large, 100 KB + 1 is large', () => {
    const atWarnLimit = summarizeAssets({
      codeBytes: 1_000,
      assets: [
        { path: 'sprites/icon.png', status: 'uploaded', sizeBytes: ASSET_SIZE_WARN_BYTES },
      ],
    });
    assert.deepEqual(atWarnLimit.large, []);

    const overWarnLimit = summarizeAssets({
      codeBytes: 1_000,
      assets: [
        { path: 'sprites/icon.png', status: 'uploaded', sizeBytes: ASSET_SIZE_WARN_BYTES + 1 },
      ],
    });
    assert.deepEqual(overWarnLimit.large, [
      { path: 'sprites/icon.png', sizeBytes: 100 * 1024 + 1 },
    ]);
  });

  it('rejected/missing sizes never count', () => {
    const summary = summarizeAssets({
      codeBytes: 20_000,
      assets: [
        { path: 'large-rejected.png', status: 'rejected', sizeBytes: 2 * 1024 * 1024 },
        { path: 'huge-missing.mp4', status: 'missing', sizeBytes: 10 * 1024 * 1024 },
      ],
    });

    assert.equal(summary.totalBytes, 20_000);
    assert.equal(summary.overTotal, false);
    assert.deepEqual(summary.large, []);
    assert.deepEqual(summary.missing, ['huge-missing.mp4']);
  });
});

describe('formatSize behavior', () => {
  it('formats under 1 MB as "N KB" with 1 decimal', () => {
    assert.equal(formatSize(0), '0.0 KB');
    assert.equal(formatSize(1024), '1.0 KB');
    assert.equal(formatSize(48 * 1024), '48.0 KB');
    assert.equal(formatSize(100 * 1024), '100.0 KB');
    assert.equal(formatSize(180 * 1024), '180.0 KB');
    assert.equal(formatSize(500 * 1024 + 512), '500.5 KB');
  });

  it('formats 1 MB and above as "N.NN MB" with 2 decimals', () => {
    assert.equal(formatSize(1024 * 1024), '1.00 MB');
    assert.equal(formatSize(4 * 1024 * 1024), '4.00 MB');
    assert.equal(formatSize(4.5 * 1024 * 1024), '4.50 MB');
    assert.equal(formatSize(1.234 * 1024 * 1024), '1.23 MB');
  });
});
