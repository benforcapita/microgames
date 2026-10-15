import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { PREVIEW_TIMEOUT_COPY, PREVIEW_WAIT_MS, createPreviewWatch, withPreviewFlag } from './upload-preview.ts';

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    clock: {
      schedule(ms: number, fn: () => void) {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      cancel(id: number) { timers.delete(id); },
    },
    pending: () => timers.size,
  };
}

describe('upload preview capture', () => {
  test('adds mg_preview=1 to the upload iframe and nowhere else', () => {
    assert.equal(
      withPreviewFlag('blob:http://127.0.0.1:4321/8b3c0c3e-1'),
      'blob:http://127.0.0.1:4321/8b3c0c3e-1?mg_preview=1',
    );
    const player = fs.readFileSync(new URL('./player.ts', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../pages/upload.astro', import.meta.url), 'utf8');
    assert.equal(player.includes('mg_preview'), false);
    assert.match(page, /withPreviewFlag\(previewUrl\)/);
    assert.match(page, /PREVIEW_TIMEOUT_COPY/);
  });

  test('shows "No preview captured, upload one." when no snapshot arrives in 8s', () => {
    assert.equal(PREVIEW_WAIT_MS, 8000);
    assert.equal(PREVIEW_TIMEOUT_COPY, 'No preview captured, upload one.');
    const time = fakeClock();
    const watch = createPreviewWatch(time.clock);
    const messages: string[] = [];
    watch.start(() => messages.push(PREVIEW_TIMEOUT_COPY));
    time.advance(7999);
    assert.deepEqual(messages, []);
    assert.equal(time.pending(), 1);
    time.advance(1);
    assert.deepEqual(messages, ['No preview captured, upload one.']);
    time.advance(8000);
    assert.deepEqual(messages, ['No preview captured, upload one.']);
  });

  test('a snapshot before 8s cancels the timeout', () => {
    const time = fakeClock();
    const watch = createPreviewWatch(time.clock);
    const messages: string[] = [];
    watch.start(() => messages.push(PREVIEW_TIMEOUT_COPY));
    time.advance(1000);
    watch.arrived();
    time.advance(9000);
    assert.deepEqual(messages, []);
    assert.equal(time.pending(), 0);
  });
});
