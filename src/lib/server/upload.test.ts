// Pure-function tests for upload rules. No Supabase client, database, or secrets.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UPLOAD, validateGameUpload, type ForkParent, type ValidatedGameUpload } from './upload.ts';

const HTML = '<html><body><canvas id="c"></canvas></body></html>';
const MISSING_PARENT = 'The game you are forking no longer exists.';

function htmlFile(size: number, name = 'game.html'): File {
  const bytes = new Uint8Array(size);
  if (size > 0) bytes.set(new TextEncoder().encode(HTML).subarray(0, Math.min(HTML.length, size)));
  return new File([bytes], name, { type: 'text/html' });
}

function thumbFile(bytes: Uint8Array, type: string, name: string): File {
  return new File([bytes], name, { type });
}

function form(fields: {
  title?: string;
  license?: string;
  omitLicense?: boolean;
  agree?: string;
  omitAgree?: boolean;
  game?: File | null;
  thumb?: File;
  forkOf?: string;
} = {}): FormData {
  const fd = new FormData();
  fd.set('title', fields.title ?? 'Sky Loop');
  if (!fields.omitLicense) fd.set('license', fields.license ?? 'MIT');
  if (!fields.omitAgree) fd.set('agree', fields.agree ?? 'on');
  if (fields.game !== null) fd.set('game', fields.game ?? htmlFile(HTML.length));
  if (fields.thumb) fd.set('thumb', fields.thumb);
  if (fields.forkOf !== undefined) fd.set('forkOf', fields.forkOf);
  return fd;
}

function parents(rows: Record<string, ForkParent>) {
  const calls: string[] = [];
  const find = async (key: string) => {
    calls.push(key);
    return rows[key] ?? null;
  };
  return { find, calls };
}

async function run(fields: Parameters<typeof form>[0] = {}, rows: Record<string, ForkParent> = {}) {
  const lookup = parents(rows);
  const result = await validateGameUpload(form(fields), lookup.find);
  return { ...result, calls: lookup.calls };
}

function ok(result: { errors: string[]; upload: ValidatedGameUpload | null }): ValidatedGameUpload {
  assert.deepEqual(result.errors, []);
  assert.ok(result.upload);
  return result.upload;
}

describe('upload validation', { concurrency: false }, () => {
  describe('size limits', () => {
    test('accepts an HTML file exactly at the byte limit', async () => {
      const upload = ok(await run({ game: htmlFile(UPLOAD.maxHtmlBytes) }));
      assert.equal(upload.html.byteLength, UPLOAD.maxHtmlBytes);
      assert.equal(new TextDecoder().decode(upload.html.subarray(0, HTML.length)), HTML);
    });

    test('rejects an HTML file one byte over the limit', async () => {
      const result = await run({ game: htmlFile(UPLOAD.maxHtmlBytes + 1) });
      assert.equal(result.upload, null);
      assert.deepEqual(result.errors, ['Game file must be under 5 MB.']);
    });

    test('rejects an empty or missing game file', async () => {
      const empty = await run({ game: htmlFile(0) });
      assert.equal(empty.upload, null);
      assert.deepEqual(empty.errors, ['Attach your game as a single .html file.']);

      const missing = await run({ game: null });
      assert.equal(missing.upload, null);
      assert.deepEqual(missing.errors, ['Attach your game as a single .html file.']);
    });

    test('accepts a thumbnail exactly at the byte limit', async () => {
      const bytes = new Uint8Array(UPLOAD.maxThumbBytes);
      bytes.set([137, 80, 78, 71]);
      const upload = ok(await run({ thumb: thumbFile(bytes, 'image/png', 'shot.png') }));
      assert.equal(upload.thumb?.bytes.byteLength, UPLOAD.maxThumbBytes);
      assert.equal(upload.thumb?.ext, 'png');
    });

    test('rejects a thumbnail one byte over the limit', async () => {
      const bytes = new Uint8Array(UPLOAD.maxThumbBytes + 1);
      const result = await run({ thumb: thumbFile(bytes, 'image/png', 'shot.png') });
      assert.equal(result.upload, null);
      assert.deepEqual(result.errors, ['Thumbnail must be under 512 KB.']);
    });

    test('ignores an empty thumbnail', async () => {
      const upload = ok(await run({ thumb: thumbFile(new Uint8Array(0), 'image/png', 'shot.png') }));
      assert.equal(upload.thumb, undefined);
    });
  });

  describe('thumbnail types', () => {
    test('accepts PNG, JPEG, and WebP and stores the extension from the MIME type', async () => {
      const cases = [
        { type: 'image/png', name: 'shot.png', ext: 'png' },
        { type: 'image/jpeg', name: 'shot.jpeg', ext: 'jpg' },
        { type: 'image/webp', name: 'shot.webp', ext: 'webp' },
      ];
      for (const item of cases) {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const upload = ok(await run({ thumb: thumbFile(bytes, item.type, item.name) }));
        assert.equal(upload.thumb?.ext, item.ext);
        assert.equal(upload.thumb?.type, item.type);
        assert.deepEqual(upload.thumb?.bytes, bytes);
      }
    });

    test('rejects disallowed thumbnail MIME types', async () => {
      for (const type of ['image/gif', 'image/svg+xml', 'image/jpg', 'image/PNG', 'text/plain', 'application/octet-stream', '']) {
        const result = await run({ thumb: thumbFile(new Uint8Array([1, 2, 3]), type, 'shot.png') });
        assert.equal(result.upload, null, type);
        assert.deepEqual(result.errors, ['Thumbnail must be PNG, JPEG or WebP.']);
      }
    });

    test('rejects an allowed extension when the MIME type is not allowed', async () => {
      for (const name of ['shot.png', 'shot.jpg', 'shot.jpeg', 'shot.webp', 'SHOT.PNG']) {
        const result = await run({ thumb: thumbFile(new Uint8Array([1, 2, 3]), 'image/gif', name) });
        assert.equal(result.upload, null, name);
        assert.deepEqual(result.errors, ['Thumbnail must be PNG, JPEG or WebP.']);
      }
    });

    test('accepts a spoofed extension and does not inspect thumbnail bytes', async () => {
      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
      const upload = ok(await run({ thumb: thumbFile(gifBytes, 'image/png', 'not-a-png.gif') }));
      assert.equal(upload.thumb?.ext, 'png');
      assert.equal(upload.thumb?.type, 'image/png');
      assert.deepEqual(upload.thumb?.bytes, gifBytes);
    });
  });

  describe('licenses', () => {
    test('accepts every license on the allow list', async () => {
      for (const license of UPLOAD.licenses) {
        const upload = ok(await run({ license }));
        assert.equal(upload.license, license);
      }
      const padded = ok(await run({ license: '  MIT  ' }));
      assert.equal(padded.license, 'MIT');
    });

    test('rejects an unknown license', async () => {
      for (const license of ['GPL-3.0', 'BSD-2-Clause', 'Public domain']) {
        const result = await run({ license });
        assert.equal(result.upload, null, license);
        assert.deepEqual(result.errors, ['Pick a license.']);
      }
    });

    test('rejects a missing license', async () => {
      for (const fields of [{ omitLicense: true }, { license: '' }, { license: '   ' }]) {
        const result = await run(fields);
        assert.equal(result.upload, null);
        assert.deepEqual(result.errors, ['Pick a license.']);
      }
    });

    test('rejects licenses that differ only by case', async () => {
      for (const license of ['mit', 'Mit', 'cc-by-sa-4.0', 'CC-by-SA-4.0', 'all rights reserved', 'ALL RIGHTS RESERVED', 'All Rights Reserved']) {
        const result = await run({ license });
        assert.equal(result.upload, null, license);
        assert.deepEqual(result.errors, ['Pick a license.']);
      }
    });
  });

  describe('fork-of', () => {
    const mit = { id: 'stk7wr01', license: 'MIT' };
    const cc = { id: 'neon1an3', license: 'CC-BY-SA-4.0' };

    test('accepts a fork of an existing remixable parent', async () => {
      const bySlug = await run({ title: 'Sky Loop Remix', forkOf: '  stack-tower  ' }, { 'stack-tower': mit });
      const slugUpload = ok(bySlug);
      assert.deepEqual(bySlug.calls, ['stack-tower']);
      assert.equal(slugUpload.forkedFrom, mit.id);

      const byId = await run({ title: 'Neon Remix', forkOf: cc.id }, { [cc.id]: cc });
      const idUpload = ok(byId);
      assert.deepEqual(byId.calls, [cc.id]);
      assert.equal(idUpload.forkedFrom, cc.id);
      assert.notEqual(idUpload.forkedFrom, idUpload.title);
    });

    test('rejects a missing parent', async () => {
      const result = await run({ forkOf: 'no-such-game' });
      assert.equal(result.upload, null);
      assert.deepEqual(result.calls, ['no-such-game']);
      assert.deepEqual(result.errors, [MISSING_PARENT]);
    });

    test('rejects a self-fork that does not name an existing game', async () => {
      const result = await run({ title: 'Sky Loop', forkOf: 'sky-loop' });
      assert.equal(result.upload, null);
      assert.deepEqual(result.calls, ['sky-loop']);
      assert.deepEqual(result.errors, [MISSING_PARENT]);

      const parent = { id: 'existing-parent', license: 'MIT' };
      const linked = ok(await run({ title: 'Sky Loop', forkOf: 'sky-loop' }, { 'sky-loop': parent }));
      assert.equal(linked.forkedFrom, parent.id);
      assert.notEqual(linked.forkedFrom, 'sky-loop');
    });

    test('rejects malformed forkOf values', async () => {
      const junk = [
        '../stack-tower',
        'stack-tower/../../index.html',
        "' OR 1=1 --",
        'sky loop',
        '.',
        'Stack-Tower',
      ];
      for (const forkOf of junk) {
        const result = await run({ forkOf }, { 'stack-tower': mit });
        assert.equal(result.upload, null, forkOf);
        assert.deepEqual(result.calls, [forkOf], forkOf);
        assert.deepEqual(result.errors, [MISSING_PARENT]);
      }

      const padded = `stk7wr01${'x'.repeat(80)}`;
      const sliced = await run({ forkOf: padded }, { stk7wr01: mit });
      assert.equal(sliced.calls[0]?.length, 64);
      assert.equal(sliced.calls[0]?.startsWith('stk7wr01'), true);
      assert.notEqual(sliced.calls[0], mit.id);
      assert.equal(sliced.upload, null);
      assert.deepEqual(sliced.errors, [MISSING_PARENT]);

      const blank = await run({ forkOf: ' \n\t ' }, { 'stack-tower': mit });
      assert.deepEqual(blank.calls, []);
      assert.equal(ok(blank).forkedFrom, null);
    });

    test('rejects a fork of an All rights reserved game', async () => {
      const reserved = { id: 'closed1', license: 'All rights reserved' };
      const result = await run({ forkOf: 'closed-game' }, { 'closed-game': reserved });
      assert.equal(result.upload, null);
      assert.deepEqual(result.calls, ['closed-game']);
      assert.deepEqual(result.errors, ['That game is not licensed for remixing.']);
    });
  });
});
