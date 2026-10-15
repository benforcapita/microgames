import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gameFrameSrc } from './frame-src.ts';

describe('gameFrameSrc', () => {
  it('produces the exact game frame URL with embed param and save hash', () => {
    const url = gameFrameSrc('http://localhost:4322', 'stk7wr01', 'http://localhost:4321', '{}');
    assert.equal(
      url,
      'http://localhost:4322/g/stk7wr01/index.html?embed=http%3A%2F%2Flocalhost%3A4321#mgs=%7B%7D',
    );
  });

  it('normalizes cdnOrigin by stripping trailing slash', () => {
    const url1 = gameFrameSrc('http://localhost:4322/', 'g1', 'http://localhost:4321', '{"score":10}');
    const url2 = gameFrameSrc('http://localhost:4322', 'g1', 'http://localhost:4321', '{"score":10}');
    assert.equal(url1, url2);
    assert.ok(!url1.includes('4322//g/'));
  });

  it('properly URI-encodes embedOrigin and save data', () => {
    const embed = 'https://meshgrounds.vercel.app';
    const save = JSON.stringify({ highscore: 9999, level: 'boss & extra' });
    const url = gameFrameSrc('https://cdn.meshgrounds.com', 'game-xyz', embed, save);
    assert.equal(
      url,
      `https://cdn.meshgrounds.com/g/game-xyz/index.html?embed=${encodeURIComponent(embed)}#mgs=${encodeURIComponent(save)}`,
    );
  });
});
