import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { ASSET_MIME } from '../../../cdn/handler.mjs';
import type { AssetDb } from './asset-manifest.ts';
import {
  ASSET_SIZE_WARN_BYTES,
  ASSET_SIZE_WARNING,
  ASSET_UPLOAD_MAX,
  ASSET_UPLOAD_WINDOW_MS,
  GAME_VERSION_MAX_BYTES,
  MAX_ASSET_FILES,
  UPLOAD_MIME,
  assessAssetUpload,
  assetFlashMessage,
  assetObjectPath,
  assetPathRejection,
  assetUploadQuery,
  assetWriteAddsCountedRow,
  createAssetUploadLimiter,
  gameTooBigMessage,
  holdApprovedGameForReview,
  saveAssetDecision,
  saveFinalizedAsset,
  type AssessAssetInput,
  type AssetStorage,
  type ExistingAsset,
} from './asset-upload.ts';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = chunk('IHDR', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const PNG_IEND = chunk('IEND', new Uint8Array());
const PNG_MIN = PNG_SIG.byteLength + PNG_IHDR.byteLength + PNG_IEND.byteLength;

function png(size = PNG_MIN): Uint8Array {
  const parts = [PNG_SIG, PNG_IHDR];
  if (size !== PNG_MIN) {
    const dataLen = size - PNG_MIN - 12;
    if (dataLen < 0) throw new Error(`png size ${size} is too small`);
    parts.push(chunk('tEXt', new Uint8Array(dataLen)));
  }
  parts.push(PNG_IEND);
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const PNG = png();

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
    for (const rawPath of ['../secrets.png', '/etc/passwd.png', 'sprites\\hero.png', 'https://evil.test/a.png']) {
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
    // A rejected row does not count toward the cap, so reviving it is a new counted row.
    const revive = assessAssetUpload(input({
      adding: true,
      fileCount: MAX_ASSET_FILES,
      existing: { ...listed, status: 'rejected' },
    }));
    assert.equal(revive.kind, 'flash');
    if (revive.kind === 'flash') assert.equal(revive.code, 'cap');
  });

  it('caps only a write that adds a counted row, at and over 200 files', () => {
    // The same case table assessAssetSign and private.record_game_asset are pinned to:
    // only a missing row (null = none) or a rejected row adds a counted row; everything
    // else — replacing an uploaded file, filling a scanned 'missing' row — is allowed
    // even when the game is already over the cap.
    for (const status of [null, 'missing', 'uploaded', 'rejected'] as const) {
      for (const fileCount of [MAX_ASSET_FILES - 1, MAX_ASSET_FILES, MAX_ASSET_FILES + 100]) {
        const decision = assessAssetUpload(input({
          adding: true,
          fileCount,
          existing: status === null ? null : { ...listed, status },
        }));
        const denied = decision.kind === 'flash' && decision.code === 'cap';
        assert.equal(
          denied,
          assetWriteAddsCountedRow(status) && fileCount >= MAX_ASSET_FILES,
          `status=${status} fileCount=${fileCount} → ${decision.kind}`,
        );
      }
    }
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
      assert.equal(audio.code, 'extension');
      assert.equal(audio.message, 'This file is png, but the path expects ogg.');
    }
  });

  it('accepts JSON for a json path and as plain text, and rejects prose filed as JSON', () => {
    const json = assessAssetUpload(input({
      rawPath: 'data/levels.json',
      existing: { path: 'data/levels.json', expectedType: 'json', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: new TextEncoder().encode('{"level":1}'),
    }));
    assert.equal(json.kind, 'store');
    if (json.kind === 'store') assert.equal(json.contentType, 'application/json; charset=utf-8');

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

describe('asset upload allowlist', () => {
  it('accepts the same extensions the CDN serves', () => {
    assert.deepEqual(UPLOAD_MIME, ASSET_MIME);
  });

  it('rejects xml, csv, and md, and a png stored under an svg path', () => {
    for (const rawPath of ['notes.xml', 'scores.csv', 'readme.md']) {
      const decision = assessAssetUpload(input({ rawPath, existing: null, adding: true, bytes: new TextEncoder().encode('hello') }));
      assert.equal(decision.kind, 'flash', rawPath);
      if (decision.kind === 'flash') assert.equal(decision.code, 'path');
    }
    const svg = assessAssetUpload(input({
      rawPath: 'sprites/hero.svg',
      existing: { path: 'sprites/hero.svg', expectedType: 'image', status: 'missing', sizeBytes: null, source: 'scan' },
      bytes: PNG,
    }));
    assert.equal(svg.kind, 'reject');
    if (svg.kind === 'reject') {
      assert.equal(svg.message, 'This file is png, but the path expects svg.');
      const flash = assetFlashMessage(new URLSearchParams(assetUploadQuery(svg)), ['sprites/hero.svg']);
      assert.equal(flash.error, svg.message);
    }
  });

  it('accepts js, mjs, css, and wasm, and still rejects an HTML document', () => {
    const js = assessAssetUpload(input({
      rawPath: 'game.js',
      existing: null,
      adding: true,
      bytes: new TextEncoder().encode('const tag = "<script>";'),
    }));
    assert.equal(js.kind, 'store');
    if (js.kind === 'store') {
      assert.equal(js.expectedType, 'text');
      assert.equal(js.contentType, 'text/javascript; charset=utf-8');
    }
    const mjs = assessAssetUpload(input({
      rawPath: 'lib/add.mjs',
      existing: null,
      adding: true,
      bytes: new TextEncoder().encode('export const n = 1;\n'),
    }));
    assert.equal(mjs.kind, 'store');
    if (mjs.kind === 'store') assert.equal(mjs.contentType, 'text/javascript; charset=utf-8');

    const css = assessAssetUpload(input({
      rawPath: 'style.css',
      existing: null,
      adding: true,
      bytes: new TextEncoder().encode('body { color: #111; }'),
    }));
    assert.equal(css.kind, 'store');
    if (css.kind === 'store') assert.equal(css.contentType, 'text/css; charset=utf-8');

    const wasm = assessAssetUpload(input({
      rawPath: 'add.wasm',
      existing: null,
      adding: true,
      bytes: Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    }));
    assert.equal(wasm.kind, 'store');
    if (wasm.kind === 'store') {
      assert.equal(wasm.expectedType, 'wasm');
      assert.equal(wasm.contentType, 'application/wasm');
    }
    assert.equal(assetObjectPath('abcdEF12', 1, 'game.js'), 'abcdEF12/1/game.js');

    const document = assessAssetUpload(input({
      rawPath: 'game.js',
      existing: null,
      adding: true,
      bytes: new TextEncoder().encode('<!doctype html><html></html>'),
    }));
    assert.equal(document.kind, 'reject');
    if (document.kind === 'reject') assert.equal(document.code, 'markup');

    const styled = assessAssetUpload(input({
      rawPath: 'style.css',
      existing: null,
      adding: true,
      bytes: new TextEncoder().encode('body { content: "<script>"; }'),
    }));
    assert.equal(styled.kind, 'reject');
    if (styled.kind === 'reject') assert.equal(styled.code, 'markup');
  });

  it('rejects a PNG that has <html><script> appended', () => {
    const polyglot = new Uint8Array(PNG.byteLength + 20);
    polyglot.set(PNG);
    polyglot.set(new TextEncoder().encode('<html><script>'), PNG.byteLength);
    const decision = assessAssetUpload(input({ bytes: polyglot }));
    assert.equal(decision.kind, 'reject');
    if (decision.kind === 'reject') assert.equal(decision.code, 'markup');
  });
});

describe('asset path encoding', () => {
  it('answers 400 for a NUL, a control character, or a bad percent-encoding', () => {
    for (const rawPath of ['sprites/%00hero.png', 'sprites/%0a.png', 'sprites/%ZZ.png', 'sprites/%', 'sprites/\u0000hero.png']) {
      const rejection = assetPathRejection(rawPath);
      assert.equal(rejection?.status, 400, rawPath);
      assert.match(rejection?.message ?? '', /NUL|control character|not encoded correctly/, rawPath);
      const decision = assessAssetUpload(input({ rawPath }));
      assert.equal(decision.kind, 'bad-request', rawPath);
      if (decision.kind === 'bad-request') assert.equal(decision.status, 400);
    }
    assert.equal(assetPathRejection('sprites/hero.png'), null);
  });

  it('answers 400 for a double-encoded .. before storage sees the path', () => {
    for (const rawPath of ['%252e%252e/secret.png', 'sprites/%252e%252e/hero.png', '%252E%252E/secret.png']) {
      const rejection = assetPathRejection(rawPath);
      assert.equal(rejection?.status, 400, rawPath);
      assert.equal(rejection?.message, 'That path is not allowed.');
      const decision = assessAssetUpload(input({ rawPath, adding: true }));
      assert.equal(decision.kind, 'bad-request', rawPath);
      if (decision.kind === 'bad-request') assert.equal(decision.status, 400);
    }
  });
});

describe('rejected replacement stays consistent with storage', () => {
  it('keeps the previous object and its counted size when the new bytes are rejected', async () => {
    const previousBytes = png(1000);
    const objects = new Map<string, Uint8Array>([['abcdEF12/1/sprites/hero.png', previousBytes]]);
    let writes = 0;
    let uploads = 0;
    const storage: AssetStorage = {
      async upload(path, bytes) {
        uploads += 1;
        objects.set(path, bytes);
        return { error: null };
      },
      async remove(path) {
        objects.delete(path);
        return { error: null };
      },
    };
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('insert into')) writes += 1;
      void values;
      return [];
    }) as unknown as AssetDb;

    const polyglot = new Uint8Array(PNG.byteLength + 20);
    polyglot.set(PNG);
    polyglot.set(new TextEncoder().encode('<html><script>'), PNG.byteLength);
    const decision = assessAssetUpload(input({
      bytes: polyglot,
      existing: { ...listed, status: 'uploaded', sizeBytes: previousBytes.byteLength },
      uploadedBytes: previousBytes.byteLength,
    }));
    assert.equal(decision.kind, 'reject');
    if (decision.kind !== 'reject') return;
    const saved = await saveAssetDecision(sql, storage, 'abcdEF12', 1, decision, polyglot, {
      status: 'uploaded',
      sizeBytes: previousBytes.byteLength,
    });
    assert.equal(saved.ok, true);
    assert.equal(uploads, 0);
    assert.equal(writes, 0);
    const stored = objects.get('abcdEF12/1/sprites/hero.png');
    assert.ok(stored);
    const counted = previousBytes.byteLength;
    assert.equal(stored?.byteLength, counted);
    assert.notEqual(Buffer.from(stored ?? []).toString('hex'), Buffer.from(polyglot).toString('hex'));
  });

  it('does not drop the counted size when a replacement would pass 4 MB', async () => {
    const previousBytes = png(1024);
    const objects = new Map<string, Uint8Array>([['abcdEF12/1/sprites/hero.png', previousBytes]]);
    const storage: AssetStorage = {
      async upload(path, bytes) {
        objects.set(path, bytes);
        return { error: null };
      },
      async remove() {
        throw new Error('the accepted object must stay');
      },
    };
    const sql = (async () => {
      throw new Error('the uploaded row must stay');
    }) as unknown as AssetDb;
    const decision = assessAssetUpload(input({
      codeBytes: GAME_VERSION_MAX_BYTES - 100,
      uploadedBytes: previousBytes.byteLength,
      existing: { ...listed, status: 'uploaded', sizeBytes: previousBytes.byteLength },
      bytes: png(1024 * 1024),
    }));
    assert.equal(decision.kind, 'reject');
    if (decision.kind !== 'reject') return;
    assert.equal(decision.code, 'too-big');
    const saved = await saveAssetDecision(sql, storage, 'abcdEF12', 1, decision, png(1024 * 1024), {
      status: 'uploaded',
      sizeBytes: previousBytes.byteLength,
    });
    assert.equal(saved.ok, true);
    assert.equal(objects.get('abcdEF12/1/sprites/hero.png')?.byteLength, previousBytes.byteLength);
  });
});

describe('asset store holds a public game when manual review is on', () => {
  const script = new TextEncoder().encode('const extra = 1;\n');
  const recorded: RecordAssetRow = {
    result: 'ok',
    total_bytes: script.byteLength,
    prev_status: null,
    prev_size_bytes: null,
    prev_sha256: null,
    prev_reject_reason: null,
    prev_source: null,
    prev_expected_type: null,
  };

  function capturingSql() {
    const queries: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      queries.push(strings.join(' '));
      if (strings.join(' ').includes('record_game_asset')) return [recorded];
      if (strings.join(' ').includes('update public.games')) return [{ id: 'abcdEF12' }];
      return [];
    }) as unknown as AssetDb;
    return { sql, queries };
  }

  async function withFlag<T>(raw: string | undefined, run: () => Promise<T>): Promise<T> {
    const prev = process.env.MG_MANUAL_REVIEW;
    if (raw === undefined) delete process.env.MG_MANUAL_REVIEW;
    else process.env.MG_MANUAL_REVIEW = raw;
    try {
      return await run();
    } finally {
      if (prev === undefined) delete process.env.MG_MANUAL_REVIEW;
      else process.env.MG_MANUAL_REVIEW = prev;
    }
  }

  it('sets stage back to pending before the asset row is written', async () => {
    await withFlag('1', async () => {
      const { sql, queries } = capturingSql();
      let uploaded = false;
      const storage: AssetStorage = {
        async upload() {
          uploaded = true;
          assert.ok(queries.some((q) => q.includes('update public.games') && q.includes('pending')));
          return { error: null };
        },
        async remove() {
          return { error: null };
        },
      };
      const decision = assessAssetUpload(input({ rawPath: 'sprites/extra.js', adding: true, existing: null, bytes: script }));
      assert.equal(decision.kind, 'store');
      if (decision.kind !== 'store') return;
      const saved = await saveFinalizedAsset(sql, storage, 'abcdEF12', 1, decision, script);
      assert.deepEqual(saved, { ok: true });
      assert.equal(uploaded, true);
      const holdAt = queries.findIndex((q) => q.includes('update public.games'));
      const rowAt = queries.findIndex((q) => q.includes('record_game_asset'));
      assert.ok(holdAt >= 0 && holdAt < rowAt);
    });
  });

  it('does not change stage when review is off', async () => {
    await withFlag('0', async () => {
      const { sql, queries } = capturingSql();
      assert.equal(await holdApprovedGameForReview(sql, 'abcdEF12'), false);
      assert.equal(queries.length, 0);
      const storage: AssetStorage = {
        async upload() {
          return { error: null };
        },
        async remove() {
          return { error: null };
        },
      };
      const decision = assessAssetUpload(input({ rawPath: 'sprites/extra.js', adding: true, existing: null, bytes: script }));
      assert.equal(decision.kind, 'store');
      if (decision.kind !== 'store') return;
      assert.equal((await saveFinalizedAsset(sql, storage, 'abcdEF12', 1, decision, script)).ok, true);
      assert.equal(queries.some((q) => q.includes('update public.games')), false);
    });
  });
});

interface RecordAssetRow {
  result: string;
  total_bytes: number;
  prev_status: null;
  prev_size_bytes: null;
  prev_sha256: null;
  prev_reject_reason: null;
  prev_source: null;
  prev_expected_type: null;
}
