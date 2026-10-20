import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { PREVIEW_TIMEOUT_COPY, PREVIEW_WAIT_MS, createPreviewWatch, injectPreview } from './upload-preview.ts';

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
  test('injects window.__MG_PREVIEW before boot and never onto the CDN or the blob URL', () => {
    const html = injectPreview('<head><title>g</title></head><canvas></canvas>', 'BOOT_MARKER');
    const flagAt = html.indexOf('<script>window.__MG_PREVIEW=true</script>');
    const bootAt = html.indexOf('<script>BOOT_MARKER</script>');
    assert.ok(flagAt >= 0 && bootAt > flagAt);
    assert.equal(html.includes('mg_preview'), false);
    const bare = injectPreview('<canvas></canvas>', 'BOOT_MARKER');
    assert.ok(bare.startsWith('<script>window.__MG_PREVIEW=true</script><script>BOOT_MARKER</script>'));
    const player = fs.readFileSync(new URL('./player.ts', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../components/UploadSection.astro', import.meta.url), 'utf8');
    const cdn = fs.readFileSync(new URL('../../cdn/handler.mjs', import.meta.url), 'utf8');
    const boot = fs.readFileSync(new URL('../../cdn/boot.js', import.meta.url), 'utf8');
    assert.match(player, /case '__MG_SNAPSHOT':/);
    assert.match(page, /injectPreview\(html, boot\)/);
    assert.equal(page.includes('mg_preview'), false);
    assert.equal(page.includes('frame.src = previewUrl'), true);
    assert.equal(cdn.includes('__MG_PREVIEW'), false);
    assert.match(boot, /window\.__MG_PREVIEW === true/);
    assert.equal(boot.includes('mg_preview'), false);
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
