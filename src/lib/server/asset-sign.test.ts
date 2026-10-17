import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES, type AssetUsage } from './asset-upload.ts';
import { assessAssetSign, parseAssetFinalizeBody, parseAssetSignBody } from './asset-sign.ts';

const OWNER = 'owner-1';
const usage = (over: Partial<AssetUsage> = {}): AssetUsage => ({ codeBytes: 1000, uploadedBytes: 2000, fileCount: 3, ...over });
const base = {
  userId: OWNER,
  ownerId: OWNER,
  rawPath: 'sfx/jump.wav',
  sizeBytes: 4096,
  existing: null,
  usage: usage(),
  rateAllowed: true,
};

describe('UP-2a parseAssetSignBody', () => {
  it('accepts {path,size,contentType} and rejects anything else', () => {
    assert.deepEqual(parseAssetSignBody({ path: 'a.png', size: 4, contentType: 'image/png' }), {
      path: 'a.png',
      sizeBytes: 4,
      contentType: 'image/png',
    });
    for (const bad of [
      null, 'x', 4, {}, [],
      { path: 4, size: 4, contentType: 'image/png' },
      { path: 'a.png', size: '4', contentType: 'image/png' },
      { path: 'a.png', size: 4.5, contentType: 'image/png' },
      { path: 'a.png', size: Number.MAX_SAFE_INTEGER + 1, contentType: 'image/png' },
      { path: 'a.png', size: 4 },
      { path: 'a.png', size: 4, contentType: 'not-a-mime' },
      { path: 'a.png', size: 4, contentType: '' },
      { path: 'a.png'.repeat(200), size: 4, contentType: 'image/png' },
    ]) {
      assert.equal(parseAssetSignBody(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseAssetFinalizeBody({ path: 'a.png' }), { path: 'a.png' });
    assert.equal(parseAssetFinalizeBody({ path: 4 }), null);
    assert.equal(parseAssetFinalizeBody(null), null);
  });
});

describe('UP-2a assessAssetSign', () => {
  it('denies anonymous (401) and non-owner (404) before looking at the path', () => {
    assert.deepEqual(assessAssetSign({ ...base, userId: null }), { ok: false, status: 401, error: 'unauthorized', message: 'Log in to upload files.' });
    const r = assessAssetSign({ ...base, userId: 'someone-else' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 404);
      assert.equal(r.error, 'not-found');
    }
    assert.equal(assessAssetSign({ ...base, userId: 'someone-else', rawPath: '../x.png' }).ok, false);
  });

  it('admits a declared size that fits and returns the canonical path', () => {
    const ok = assessAssetSign(base);
    assert.deepEqual(ok, { ok: true, path: 'sfx/jump.wav' });
    assert.deepEqual(assessAssetSign({ ...base, rawPath: './sfx//jump.wav?x=1' }), { ok: true, path: 'sfx/jump.wav' });
  });

  it('applies the path rules before the rate limit and cap', () => {
    for (const rawPath of ['../x.png', '/x.png', 'x\\y.png', 'a.php', 'noext', '%zz.png', 'a%2e%2e%2fb.png', 'index.htm']) {
      const r = assessAssetSign({ ...base, rawPath });
      assert.equal(r.ok, false, rawPath);
      if (!r.ok) assert.equal(r.status, 400, rawPath);
    }
    assert.equal(assessAssetSign({ ...base, rawPath: '../x.png', rateAllowed: false }).ok, false);
    const rate = assessAssetSign({ ...base, rateAllowed: false });
    assert.equal(rate.ok, false);
    if (!rate.ok) assert.equal(rate.error, 'rate');
  });

  it('enforces the 200-file cap only for a path with no existing row', () => {
    const atCap = usage({ fileCount: MAX_ASSET_FILES });
    const r = assessAssetSign({ ...base, usage: atCap });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'cap');
    const replacing = assessAssetSign({
      ...base,
      usage: atCap,
      existing: { path: 'sfx/jump.wav', expectedType: 'audio', status: 'missing', sizeBytes: null, source: 'scan' },
    });
    assert.equal(replacing.ok, true);
  });

  it('enforces the 4 MB version cap against the declared size', () => {
    const fits = assessAssetSign({ ...base, sizeBytes: GAME_VERSION_MAX_BYTES - 3000 });
    assert.equal(fits.ok, true);
    const over = assessAssetSign({ ...base, sizeBytes: GAME_VERSION_MAX_BYTES - 2999 });
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.equal(over.status, 413);
      assert.equal(over.error, 'too-big');
    }
    // Replacing an uploaded file does not double-count its old bytes.
    const replacing = assessAssetSign({
      ...base,
      sizeBytes: 2500,
      usage: usage({ uploadedBytes: GAME_VERSION_MAX_BYTES - 1000 }),
      existing: { path: 'sfx/jump.wav', expectedType: 'audio', status: 'uploaded', sizeBytes: GAME_VERSION_MAX_BYTES - 2000, source: 'scan' },
    });
    assert.equal(replacing.ok, true);
  });

  it('rejects a declared size of 0', () => {
    const r = assessAssetSign({ ...base, sizeBytes: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'empty');
  });
});
