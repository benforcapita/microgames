import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASSET_STALE_AGE_MS,
  ASSET_UPLOAD_ID_TTL_MS,
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  assetWriteAddsCountedRow,
  type AssetUsage,
} from './asset-upload.ts';
import { assessAssetSign, mintAssetUploadId, parseAssetFinalizeBody, parseAssetSignBody, verifyAssetUploadId } from './asset-sign.ts';

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
  // A fixed clock on a whole-second boundary: the wire expiry is epoch seconds, so the
  // expiry assertions below must not depend on the wall clock.
  const NOW = 1_800_000_000_000;

  it('mints an uploadId that resolves to the staged object for the same game/version/path', () => {
    const { uploadId, nonce, expiresAt } = mintAssetUploadId(SECRET, 'gameId01', 3, 'sfx/jump.wav', NOW);
    assert.match(uploadId, /^[A-Za-z0-9_-]{16}\.\d{6,13}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresAt, NOW + ASSET_UPLOAD_ID_TTL_MS);
    assert.deepEqual(verifyAssetUploadId(SECRET, 'gameId01', 3, 'sfx/jump.wav', uploadId, NOW + 1), {
      kind: 'ok',
      stagedPath: `gameId01/_staging/${nonce}`,
    });
  });

  it('signs the expiry: a tampered or two-segment id is invalid, an authentic one reports expired past its TTL', () => {
    const { uploadId, nonce } = mintAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', NOW);
    const [n, exp, sig] = uploadId.split('.');
    // Extending the expiry breaks the HMAC — the window cannot be widened client-side.
    assert.equal(
      verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', `${n}.${Number(exp) + 100000}.${sig}`, NOW).kind,
      'invalid',
    );
    // A pre-UP-4 two-segment id no longer verifies at all.
    assert.equal(verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', `${nonce}.${sig}`, NOW).kind, 'invalid');
    // Inside the TTL it verifies; past it the same authentic id reports 'expired', not
    // 'invalid' — finalize answers that with the distinct upload_expired code.
    assert.equal(
      verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', uploadId, NOW + ASSET_UPLOAD_ID_TTL_MS - 1).kind,
      'ok',
    );
    const late = verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', uploadId, NOW + ASSET_UPLOAD_ID_TTL_MS + 1);
    assert.equal(late.kind, 'expired');
    // The expired verdict still carries the staged path so the caller can clean it up.
    if (late.kind === 'expired') assert.match(late.stagedPath, /^gameId01\/_staging\//);
  });

  it('rejects a tampered, foreign, malformed or wrong-secret uploadId', () => {
    const { uploadId } = mintAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', NOW);
    const [nonce, exp, sig] = uploadId.split('.');
    for (const bad of [
      `${nonce}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, // tampered signature
      `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${exp}.${sig}`, // tampered nonce
      'no-dot', `${nonce}`, `..${exp}.${sig}`, `${nonce}.${exp}.`, `${nonce}..${sig}`, `${nonce}.${exp}`,
      `${nonce}.notanumber.${sig}`, `${nonce}.${exp}.${sig}.extra`,
    ]) {
      assert.equal(verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/jump.wav', bad, NOW).kind, 'invalid', bad);
    }
    // Bound to (game, version, path): none of these may resolve.
    assert.equal(verifyAssetUploadId(SECRET, 'gameId01', 1, 'sfx/other.wav', uploadId, NOW).kind, 'invalid');
    assert.equal(verifyAssetUploadId(SECRET, 'gameId01', 2, 'sfx/jump.wav', uploadId, NOW).kind, 'invalid');
    assert.equal(verifyAssetUploadId(SECRET, 'othergm1', 1, 'sfx/jump.wav', uploadId, NOW).kind, 'invalid');
    assert.equal(verifyAssetUploadId('wrong-secret', 'gameId01', 1, 'sfx/jump.wav', uploadId, NOW).kind, 'invalid');
    // Unsafe to join: ids and nonces outside the charset never reach Storage.
    assert.equal(verifyAssetUploadId(SECRET, '../evil', 1, 'sfx/jump.wav', uploadId, NOW).kind, 'invalid');
    assert.equal(verifyAssetUploadId(SECRET, 'gameId01', 0, 'sfx/jump.wav', uploadId, NOW).kind, 'invalid');
  });

  it('the staging prefix is outside anything the CDN maps (version must be numeric)', () => {
    const minted = mintAssetUploadId(SECRET, 'gameId01', 1, 'x.png', NOW);
    const verified = verifyAssetUploadId(SECRET, 'gameId01', 1, 'x.png', minted.uploadId, NOW);
    assert.ok(verified.kind === 'ok', 'a fresh uploadId verifies');
    if (verified.kind === 'ok') {
      assert.ok(verified.stagedPath.startsWith('gameId01/_staging/'), 'staged key under the game prefix');
      assert.doesNotMatch(verified.stagedPath.split('/')[1], /^\d{1,9}$/);
    }
  });
});

describe('UP-4 uploadId and sweep TTLs', () => {
  it('the sweep age is the uploadId TTL plus a wide margin', () => {
    // An uploadId stays finalizable for ASSET_UPLOAD_ID_TTL_MS; its staged object (and an
    // unfinished reservation) may only be swept after ASSET_STALE_AGE_MS. The margin absorbs
    // clock skew and a slow finalize so a still-valid upload is never swept.
    assert.ok(ASSET_UPLOAD_ID_TTL_MS > 0);
    assert.ok(ASSET_STALE_AGE_MS >= ASSET_UPLOAD_ID_TTL_MS + 30 * 60_000);
  });

  it('pins the exact constants: uploadId TTL is 15 minutes, stale age is 2 hours', () => {
    // The whole safety story assumes these exact values (QA #79 Q7d/Q7f survived: nothing
    // pinned them). A still-finalizable upload can stage at TTL-1ms; the sweep must wait
    // well past it.
    assert.equal(ASSET_UPLOAD_ID_TTL_MS, 15 * 60_000);
    assert.equal(ASSET_STALE_AGE_MS, 2 * 60 * 60_000);
  });

  it('expiresAt is exactly the signed deadline — the client is never shown a later time', () => {
    // exp is floored to seconds inside the signature; the ms-side expiresAt must equal
    // that same deadline, not sit up to 999 ms past it (QA #79 item 7). Mint at a
    // non-second-aligned instant so a wrong floor would differ.
    const skewed = 1_800_000_000_617;
    const secret = 'ttl-test-secret';
    const { uploadId, expiresAt } = mintAssetUploadId(secret, 'gameId01', 1, 'x.png', skewed);
    const signedExp = Number(uploadId.split('.')[1]) * 1000;
    assert.equal(expiresAt, signedExp, 'expiresAt must be the signed deadline exactly');
    assert.equal(verifyAssetUploadId(secret, 'gameId01', 1, 'x.png', uploadId, signedExp).kind, 'ok');
    assert.equal(verifyAssetUploadId(secret, 'gameId01', 1, 'x.png', uploadId, signedExp + 1).kind, 'expired');
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

  it('enforces the 200-file cap only for a path with no counted row', () => {
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

  it('rejected rows are free of the cap, but reviving one at the cap is denied', () => {
    const atCap = usage({ fileCount: MAX_ASSET_FILES });
    const revive = assessAssetSign({
      ...base,
      usage: atCap,
      existing: { path: 'sfx/jump.wav', expectedType: 'audio', status: 'rejected', sizeBytes: null, source: 'scan' },
    });
    assert.equal(revive.ok, false);
    if (!revive.ok) assert.equal(revive.error, 'cap');
    // Below the cap the same rejected row is a normal sign again.
    const ok = assessAssetSign({
      ...base,
      existing: { path: 'sfx/jump.wav', expectedType: 'audio', status: 'rejected', sizeBytes: null, source: 'scan' },
    });
    assert.equal(ok.ok, true);
  });

  it('denies the file cap only when the sign would add a counted row, at and over 200', () => {
    // Same case table as assessAssetUpload and private.record_game_asset — existing games
    // can sit over 200 counted rows (manifest scans bypass the cap), and filling or
    // replacing an existing counted row must still be admitted.
    for (const status of [null, 'missing', 'uploaded', 'rejected'] as const) {
      for (const fileCount of [MAX_ASSET_FILES - 1, MAX_ASSET_FILES, MAX_ASSET_FILES + 100]) {
        const r = assessAssetSign({
          ...base,
          usage: usage({ fileCount }),
          existing: status === null ? null : { path: 'sfx/jump.wav', expectedType: 'audio', status, sizeBytes: null, source: 'scan' },
        });
        const denied = !r.ok && r.error === 'cap';
        assert.equal(
          denied,
          assetWriteAddsCountedRow(status) && fileCount >= MAX_ASSET_FILES,
          `status=${status} fileCount=${fileCount}`,
        );
      }
    }
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
