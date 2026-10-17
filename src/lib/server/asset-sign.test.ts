import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAME_VERSION_MAX_BYTES, MAX_ASSET_FILES, type AssetUsage } from './asset-upload.ts';
import { assessAssetSign, mintAssetUploadId, parseAssetFinalizeBody, parseAssetSignBody, stagedObjectPath } from './asset-sign.ts';

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
    assert.deepEqual(parseAssetFinalizeBody({ path: 'a.png', uploadId: 'u' }), { path: 'a.png', uploadId: 'u' });
    assert.equal(parseAssetFinalizeBody({ path: 'a.png' }), null);
    assert.equal(parseAssetFinalizeBody({ path: 4, uploadId: 'u' }), null);
    assert.equal(parseAssetFinalizeBody({ path: 'a.png', uploadId: 4 }), null);
    assert.equal(parseAssetFinalizeBody(null), null);
  });
});

describe('UP-2a uploadId binding and staging path', () => {
  const SECRET = 'test-service-key';
  it('mints an uploadId that resolves to the staged object for the same game/version/path', () => {
    const { uploadId, nonce } = mintAssetUploadId(SECRET, 'gameId01', 3, 'sfx/jump.wav');
    assert.match(uploadId, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(stagedObjectPath(SECRET, 'gameId01', 3, 'sfx/jump.wav', uploadId), `gameId01/_staging/${nonce}`);
  });
  it('rejects a tampered, foreign, malformed or wrong-secret uploadId', () => {
    const { uploadId } = mintAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav');
    const [nonce, sig] = uploadId.split('.');
    for (const bad of [
      `${nonce}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, // tampered signature
      `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${sig}`, // tampered nonce
      'no-dot', `${nonce}`, `..${sig}`, `${nonce}.`, `.${sig}`,
    ]) {
      assert.equal(stagedObjectPath(SECRET, 'gameId01', 1, 'sfx/jump.wav', bad), null, bad);
    }
    // Bound to (game, version, path): none of these may resolve.
    assert.equal(stagedObjectPath(SECRET, 'gameId01', 1, 'sfx/other.wav', uploadId), null);
    assert.equal(stagedObjectPath(SECRET, 'gameId01', 2, 'sfx/jump.wav', uploadId), null);
    assert.equal(stagedObjectPath(SECRET, 'othergm1', 1, 'sfx/jump.wav', uploadId), null);
    assert.equal(stagedObjectPath('wrong-secret', 'gameId01', 1, 'sfx/jump.wav', uploadId), null);
    // Unsafe to join: ids and nonces outside the charset never reach Storage.
    assert.equal(stagedObjectPath(SECRET, '../evil', 1, 'sfx/jump.wav', uploadId), null);
    assert.equal(stagedObjectPath(SECRET, 'gameId01', 0, 'sfx/jump.wav', uploadId), null);
  });
  it('the staging prefix is outside anything the CDN maps (version must be numeric)', () => {
    const path = stagedObjectPath(SECRET, 'gameId01', 1, 'x.png', mintAssetUploadId(SECRET, 'gameId01', 1, 'x.png').uploadId);
    assert.ok(path !== null && path.startsWith('gameId01/_staging/'), 'staged key under the game prefix');
    assert.doesNotMatch(path.split('/')[1], /^\d{1,9}$/);
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
