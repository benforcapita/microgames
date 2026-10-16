import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ASSET_SIZE_WARN_BYTES,
  ASSET_SIZE_WARNING,
  ASSET_UPLOAD_MAX,
  ASSET_UPLOAD_WINDOW_MS,
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  assessAssetUpload,
  assetFlashMessage,
  assetObjectPath,
  assetUploadQuery,
  createAssetUploadLimiter,
  gameTooBigMessage,
  type AssessAssetInput,
  type ExistingAsset,
} from './asset-upload.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG);
  return bytes;
}

const listed: ExistingAsset = {
  path: 'sprites/hero.png',
  expectedType: 'image',
  status: 'missing',
  sizeBytes: null,
  source: 'scan',
};

function input(patch: Partial<AssessAssetInput> = {}): AssessAssetInput {
  return {
    userId: 'owner',
    ownerId: 'owner',
    rawPath: 'sprites/hero.png',
    adding: false,
    bytes: PNG,
    existing: listed,
    codeBytes: 1000,
    uploadedBytes: 0,
    fileCount: 1,
    rateAllowed: true,
    ...patch,
  };
}

describe('asset upload ownership and rate limit', () => {
  it('sends an anonymous visitor to sign in and hides a game from someone else', () => {
    assert.equal(assessAssetUpload(input({ userId: null })).kind, 'login');
    assert.equal(assessAssetUpload(input({ userId: 'other' })).kind, 'not-found');
    assert.equal(assessAssetUpload(input({ ownerId: null })).kind, 'not-found');
    const limited = assessAssetUpload(input({ userId: 'other', rateAllowed: false }));
    assert.equal(limited.kind, 'not-found');
  });

  it('refuses the owner once they pass 30 uploads in 10 minutes, and resets after the window', () => {
    let now = 1_000;
    const limiter = createAssetUploadLimiter(() => now);
    for (let i = 0; i < ASSET_UPLOAD_MAX; i++) assert.equal(limiter.hit('owner'), true);
    assert.equal(limiter.hit('owner'), false);
    assert.equal(limiter.hit('someone-else'), true);
    const blocked = assessAssetUpload(input({ rateAllowed: limiter.hit('owner') }));
    assert.equal(blocked.kind, 'flash');
    if (blocked.kind === 'flash') assert.equal(blocked.code, 'rate');

    now += ASSET_UPLOAD_WINDOW_MS;
    assert.equal(limiter.hit('owner'), true);
    assert.equal(ASSET_UPLOAD_WINDOW_MS, 10 * 60_000);
  });
});

describe('asset upload paths', () => {
  it('rejects unsafe paths and paths that are not listed, and accepts an added creator file', () => {
    for (const rawPath of ['../secrets.png', '/etc/passwd.png', 'sprites\\hero.png', 'https://evil.test/a.png', 'index.html']) {
      const decision = assessAssetUpload(input({ rawPath, existing: null }));
      assert.equal(decision.kind, 'flash', rawPath);
      if (decision.kind === 'flash') assert.equal(decision.code, 'path');
    }
    const missing = assessAssetUpload(input({ rawPath: 'sprites/other.png', existing: null, adding: false }));
    assert.equal(missing.kind, 'flash');
    if (missing.kind === 'flash') assert.equal(missing.code, 'manifest');

    const added = assessAssetUpload(input({ rawPath: './sounds/jump.ogg', existing: null, adding: true, bytes: new TextEncoder().encode('OggS') }));
    assert.equal(added.kind, 'store');
    if (added.kind === 'store') {
      assert.equal(added.path, 'sounds/jump.ogg');
      assert.equal(added.expectedType, 'audio');
      assert.equal(added.source, 'creator');
      assert.equal(added.contentType, 'audio/ogg');
    }
  });

  it('stops a new file at 200 and still allows a replacement', () => {
    const capped = assessAssetUpload(input({ existing: null, adding: true, fileCount: MAX_ASSET_FILES }));
    assert.equal(capped.kind, 'flash');
    if (capped.kind === 'flash') assert.equal(capped.code, 'cap');
    const replaced = assessAssetUpload(input({ fileCount: MAX_ASSET_FILES }));
    assert.equal(replaced.kind, 'store');
  });

  it('builds a bucket key only for a safe game, version, and normalized path', () => {
    assert.equal(assetObjectPath('abcdEF12', 3, 'sprites/hero.png'), 'abcdEF12/3/sprites/hero.png');
    assert.equal(assetObjectPath('../abcdEF', 1, 'a.png'), null);
    assert.equal(assetObjectPath('abcdEF12', 0, 'a.png'), null);
    assert.equal(assetObjectPath('abcdEF12', 1, '../a.png'), null);
    assert.equal(assetObjectPath('abcdEF12', 1, './sprites/hero.png'), null);
  });
});

describe('asset upload bytes', () => {
  it('rejects SVG, HTML, and a file that does not match the path', () => {
    const svg = assessAssetUpload(input({ bytes: new TextEncoder().encode('<svg></svg>') }));
    assert.equal(svg.kind, 'reject');
    if (svg.kind === 'reject') {
      assert.equal(svg.code, 'markup');
      assert.equal(svg.message, 'SVG and HTML files are not allowed.');
    }
    const html = assessAssetUpload(input({ bytes: new TextEncoder().encode('<!doctype html><html></html>') }));
    assert.equal(html.kind, 'reject');
    if (html.kind === 'reject') assert.equal(html.code, 'markup');

    const audio = assessAssetUpload(input({
      rawPath: 'sounds/jump.ogg',
      existing: { path: 'sounds/jump.ogg', expectedType: 'audio', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: PNG,
    }));
    assert.equal(audio.kind, 'reject');
    if (audio.kind === 'reject') {
      assert.equal(audio.code, 'mismatch');
      assert.equal(audio.message, 'This file is image, but the path expects audio.');
    }
  });

  it('accepts JSON for a json path and as plain text, and rejects prose filed as JSON', () => {
    const json = assessAssetUpload(input({
      rawPath: 'data/levels.json',
      existing: { path: 'data/levels.json', expectedType: 'json', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: new TextEncoder().encode('{"level":1}'),
    }));
    assert.equal(json.kind, 'store');
    if (json.kind === 'store') assert.equal(json.contentType, 'application/json');

    const asText = assessAssetUpload(input({
      rawPath: 'readme.txt',
      existing: { path: 'readme.txt', expectedType: 'text', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: new TextEncoder().encode('{"level":1}'),
    }));
    assert.equal(asText.kind, 'store');
    if (asText.kind === 'store') assert.equal(asText.contentType, 'text/plain; charset=utf-8');

    const prose = assessAssetUpload(input({
      rawPath: 'data/levels.json',
      existing: { path: 'data/levels.json', expectedType: 'json', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: new TextEncoder().encode('not json'),
    }));
    assert.equal(prose.kind, 'reject');
    if (prose.kind === 'reject') assert.equal(prose.message, 'This file is text, but the path expects json.');
  });

  it('rejects an upload that would put the version over 4 MB and says how big it would be', () => {
    const decision = assessAssetUpload(input({
      codeBytes: 3 * 1024 * 1024,
      uploadedBytes: 1024 * 1024,
      bytes: png(1024 * 1024),
    }));
    assert.equal(decision.kind, 'reject');
    if (decision.kind !== 'reject') return;
    assert.equal(decision.code, 'too-big');
    assert.equal(decision.totalBytes, 5 * 1024 * 1024);
    assert.equal(
      decision.message,
      'This file would bring your game to 5.00 MB; the whole game, code plus assets, must stay under 4 MB',
    );
    assert.equal(decision.message, gameTooBigMessage(decision.totalBytes));
  });

  it('counts a replacement against the old file, allows exactly 4 MB, and warns over 100 KB', () => {
    const kept = assessAssetUpload(input({
      codeBytes: 2 * 1024 * 1024,
      uploadedBytes: 2 * 1024 * 1024,
      existing: { ...listed, status: 'uploaded', sizeBytes: 2 * 1024 * 1024 },
      bytes: png(2 * 1024 * 1024),
    }));
    assert.equal(kept.kind, 'store');

    const exact = assessAssetUpload(input({ codeBytes: 0, bytes: png(GAME_VERSION_MAX_BYTES) }));
    assert.equal(exact.kind, 'store');
    if (exact.kind === 'store') assert.equal(exact.warning, ASSET_SIZE_WARNING);

    const over = assessAssetUpload(input({ codeBytes: GAME_VERSION_MAX_BYTES - PNG.byteLength + 1, bytes: PNG }));
    assert.equal(over.kind, 'reject');
    if (over.kind === 'reject') {
      assert.equal(over.totalBytes, GAME_VERSION_MAX_BYTES + 1);
      assert.equal(over.message, gameTooBigMessage(GAME_VERSION_MAX_BYTES + 1));
      assert.match(over.message, /4\.000001 MB/);
    }

    const atWarn = assessAssetUpload(input({ bytes: png(ASSET_SIZE_WARN_BYTES) }));
    assert.equal(atWarn.kind, 'store');
    if (atWarn.kind === 'store') assert.equal(atWarn.warning, null);

    const justOver = assessAssetUpload(input({ bytes: png(ASSET_SIZE_WARN_BYTES + 1) }));
    assert.equal(justOver.kind, 'store');
    if (justOver.kind === 'store') {
      assert.equal(justOver.warning, 'This asset is over 100 KB.');
      assert.equal(justOver.sha256, crypto.createHash('sha256').update(png(ASSET_SIZE_WARN_BYTES + 1)).digest('hex'));
      assert.equal(justOver.sha256.length, 64);
    }
  });

  it('tells the page to flash the size error and the 100 KB warning', () => {
    const tooBig = assessAssetUpload(input({ codeBytes: GAME_VERSION_MAX_BYTES, bytes: png(2048) }));
    assert.equal(tooBig.kind, 'reject');
    if (tooBig.kind !== 'reject' || tooBig.totalBytes === undefined) return;
    const error = assetFlashMessage(new URLSearchParams(assetUploadQuery(tooBig)), ['sprites/hero.png']);
    assert.equal(error.notice, null);
    assert.equal(error.error, gameTooBigMessage(tooBig.totalBytes));

    const warned = assessAssetUpload(input({ bytes: png(ASSET_SIZE_WARN_BYTES + 1) }));
    assert.equal(warned.kind, 'store');
    if (warned.kind !== 'store') return;
    const notice = assetFlashMessage(new URLSearchParams(assetUploadQuery(warned)), ['sprites/hero.png']);
    assert.equal(notice.error, null);
    assert.equal(notice.notice, 'Uploaded sprites/hero.png. This asset is over 100 KB.');
    const forged = assetFlashMessage(new URLSearchParams({ uploaded: '../secret.png', warn: '1' }), ['sprites/hero.png']);
    assert.equal(forged.notice, null);
  });
});
