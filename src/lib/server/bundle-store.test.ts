import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveUploadedBundle, type BundleStorage } from './bundle-store.ts';

const HTML = new Uint8Array([1, 2, 3]);
const THUMB = new Uint8Array([4, 5]);

function storageMock(removeResult: { error: { message: string } | null } | Error): BundleStorage & { removed: string[][] } {
  return {
    removed: [],
    async upload() {
      return { error: null };
    },
    async remove(paths) {
      this.removed.push(paths);
      if (removeResult instanceof Error) throw removeResult;
      return removeResult;
    },
  };
}

describe('orphaned bundle cleanup', () => {
  it('deletes the stored objects when the games insert is rejected', async () => {
    const insertError = Object.assign(new Error('new row violates check constraint "games_stage_check"'), { code: '23514' });
    const storage = storageMock({ error: null });
    let inserted = false;
    const client = {
      async insert() {
        inserted = true;
        throw insertError;
      },
    };

    await assert.rejects(
      () => saveUploadedBundle({
        objects: [
          { path: 'abc/index.html', bytes: HTML, contentType: 'text/html; charset=utf-8' },
          { path: 'abc/thumb.png', bytes: THUMB, contentType: 'image/png' },
        ],
        storage,
        insert: () => client.insert(),
      }),
      (err) => err === insertError,
    );

    assert.equal(inserted, true);
    assert.deepEqual(storage.removed, [['abc/index.html', 'abc/thumb.png']]);
  });

  it('logs a cleanup failure and still throws the original insert error', async () => {
    const insertError = new Error('insert failed');
    const returned = { message: 'storage remove failed' };
    const thrown = Object.assign(new Error('storage unavailable'), { status: 500 });
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const objects = [{ path: 'abc/index.html', bytes: HTML, contentType: 'text/html; charset=utf-8' }];
    const insert = async () => {
      throw insertError;
    };
    try {
      await assert.rejects(
        () => saveUploadedBundle({ objects, storage: storageMock({ error: returned }), insert }),
        (err) => err === insertError,
      );
      await assert.rejects(
        () => saveUploadedBundle({ objects, storage: storageMock(thrown), insert }),
        (err) => err === insertError,
      );
    } finally {
      console.error = original;
    }

    assert.equal(logged.length, 2);
    assert.match(String(logged[0][0]), /Failed to delete stored game bundle \(abc\/index\.html\)/);
    assert.equal(logged[0][1], returned);
    assert.match(String(logged[1][0]), /Failed to delete stored game bundle \(abc\/index\.html\)/);
    assert.equal(logged[1][1], thrown);
  });
});
