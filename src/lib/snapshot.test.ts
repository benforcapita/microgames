// Capture helpers live in cdn/boot.js (injected into the game frame). This evaluates that block.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { UPLOAD } from './server/upload.ts';

const boot = fs.readFileSync(new URL('../../cdn/boot.js', import.meta.url), 'utf8');
const marked = boot.match(/\/\* snapshot-lib \*\/([\s\S]*?)\/\* end-snapshot-lib \*\//);
if (!marked) throw new Error('snapshot-lib block missing from cdn/boot.js');

const snap = new Function(`${marked[1]}; return { SNAP_MAX_W, SNAP_MAX_H, SNAP_MAX_BYTES, fitSnapshotBox, isBlankSample, captureCanvas, glContextAttrs, snapshotError };`)() as {
  SNAP_MAX_W: number;
  SNAP_MAX_H: number;
  SNAP_MAX_BYTES: number;
  fitSnapshotBox: (w: number, h: number, maxW: number, maxH: number) => { width: number; height: number } | null;
  isBlankSample: (data: Uint8Array) => boolean;
  captureCanvas: (canvas: { width: number; height: number }, createCanvas: (w: number, h: number) => unknown) => { ok: boolean; reason?: string; dataUrl?: string; type?: string };
  glContextAttrs: (type: string, attrs: Record<string, unknown> | undefined) => { type: string; attrs: Record<string, unknown> | undefined };
  snapshotError: (reason: string) => string;
};

function bootFrame(opts: { search?: string; preview?: unknown } = {}) {
  const posts: { type?: string }[] = [];
  const getContextCalls: { type: string; attrs: Record<string, unknown> | undefined }[] = [];
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const rafs: Array<(t: number) => void> = [];
  let nextTimer = 1;
  const parent = { postMessage(data: { type?: string }) { posts.push(data); } };
  function HTMLCanvasElement(this: { width: number; height: number }) {
    this.width = 0;
    this.height = 0;
  }
  HTMLCanvasElement.prototype.getContext = function (type: string, attrs?: Record<string, unknown>) {
    getContextCalls.push({ type, attrs });
    return { type, attrs };
  };
  function HTMLMediaElement() {}
  HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  const location = { search: opts.search ?? '', hash: '', pathname: '/index.html' };
  const windowObj: Record<string, unknown> = {
    __MG_PREVIEW: opts.preview,
    parent,
    location,
    history: { replaceState() {} },
    performance: { now: () => 42 },
    document: {
      cookie: '',
      getElementsByTagName: () => [],
      createElement: () => ({}),
    },
    HTMLCanvasElement,
    HTMLMediaElement,
    requestAnimationFrame(cb: (t: number) => void) { rafs.push(cb); return rafs.length; },
    cancelAnimationFrame() {},
    addEventListener() {},
    dispatchEvent() {},
  };
  const context: vm.Context = {
    window: windowObj,
    parent,
    location,
    history: windowObj.history,
    performance: windowObj.performance,
    document: windowObj.document,
    HTMLCanvasElement,
    HTMLMediaElement,
    setTimeout(fn: () => void, ms?: number) {
      const id = nextTimer++;
      timeouts.set(id, { fn, ms: ms ?? 0 });
      return id;
    },
    clearTimeout(id: number) { timeouts.delete(id); },
    Map, Set, Object, Array, Math, Promise, String, Number, Error,
    ErrorEvent: class ErrorEvent {},
  };
  vm.createContext(context);
  vm.runInContext(boot, context);
  const mg = windowObj.Meshground as { ready: () => void };
  return {
    posts,
    getContextCalls,
    timeouts,
    rafs,
    ready: () => mg.ready(),
    requestAnimationFrame: windowObj.requestAnimationFrame as (cb: (t: number) => void) => number,
    canvas: () => new (HTMLCanvasElement as unknown as new () => { getContext: (type: string, attrs?: Record<string, unknown>) => unknown })(),
    flush() {
      const queued = [...timeouts.values()];
      timeouts.clear();
      queued.forEach((timer) => timer.fn());
      const frames = rafs.splice(0);
      frames.forEach((cb) => cb(16));
    },
  };
}

const tiny = 'AAAA';
const webp = (payload: string) => `data:image/webp;base64,${payload}`;
const png = (payload: string) => `data:image/png;base64,${payload}`;

function pixels(varied: boolean): Uint8Array {
  const data = new Uint8Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    data[i * 4] = varied ? i * 30 : 4;
    data[i * 4 + 1] = 8;
    data[i * 4 + 2] = varied ? 180 : 8;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function dest(data: Uint8Array, toDataURL: (type: string, quality?: number) => string) {
  return {
    getContext() {
      return {
        drawImage() {},
        getImageData() { return { data }; },
      };
    },
    toDataURL,
  };
}

describe('snapshot capture', () => {
  test('uses the same pixel cap as uploaded thumbnails and a 150 KB capture budget', () => {
    assert.equal(snap.SNAP_MAX_W, UPLOAD.maxThumbWidth);
    assert.equal(snap.SNAP_MAX_H, UPLOAD.maxThumbHeight);
    assert.equal(snap.SNAP_MAX_BYTES, 150 * 1024);
    assert.equal(UPLOAD.maxThumbWidth, 640);
    assert.equal(UPLOAD.maxThumbHeight, 360);
  });

  test('scales down to fit 640x360 and does not scale up', () => {
    assert.deepEqual(snap.fitSnapshotBox(1920, 1080, 640, 360), { width: 640, height: 360 });
    assert.deepEqual(snap.fitSnapshotBox(800, 800, 640, 360), { width: 360, height: 360 });
    assert.deepEqual(snap.fitSnapshotBox(100, 80, 640, 360), { width: 100, height: 80 });
    assert.equal(snap.fitSnapshotBox(0, 100, 640, 360), null);
    assert.equal(snap.fitSnapshotBox(100, 0, 640, 360), null);
  });

  test('treats a solid or empty frame as blank and a varied frame as not', () => {
    assert.equal(snap.isBlankSample(pixels(false)), true);
    assert.equal(snap.isBlankSample(pixels(true)), false);
    assert.equal(snap.isBlankSample(new Uint8Array(16)), true);
  });

  test('prefers a webp data URL', () => {
    const calls: string[] = [];
    const shot = snap.captureCanvas({ width: 320, height: 180 }, () => dest(pixels(true), (type) => {
      calls.push(type);
      return type === 'image/webp' ? webp(tiny) : png(tiny);
    }));
    assert.equal(shot.ok, true);
    assert.equal(shot.type, 'image/webp');
    assert.deepEqual(calls, ['image/webp']);
  });

  test('falls back to png when webp encoding is not available', () => {
    const calls: string[] = [];
    const shot = snap.captureCanvas({ width: 320, height: 180 }, () => dest(pixels(true), (type) => {
      calls.push(type);
      return png(tiny);
    }));
    assert.equal(shot.ok, true);
    assert.equal(shot.type, 'image/png');
    assert.deepEqual(calls, ['image/webp', 'image/png']);
  });

  test('reports a tainted canvas when capture throws', () => {
    const shot = snap.captureCanvas({ width: 200, height: 100 }, () => dest(pixels(true), () => {
      throw new Error('SecurityError');
    }));
    assert.deepEqual(shot, { ok: false, reason: 'tainted' });
    assert.match(snap.snapshotError('tainted'), /preserveDrawingBuffer/);
    assert.match(snap.snapshotError('tainted'), /Upload a PNG, JPEG, or WebP thumbnail/);
  });

  test('reports a blank frame instead of posting it', () => {
    const shot = snap.captureCanvas({ width: 200, height: 100 }, () => dest(pixels(false), () => webp(tiny)));
    assert.deepEqual(shot, { ok: false, reason: 'blank' });
    assert.match(snap.snapshotError('blank'), /blank/);
    assert.match(snap.snapshotError('blank'), /Upload a PNG, JPEG, or WebP thumbnail/);
  });

  test('lowers quality until the preview is under 150 KB', () => {
    const qualities: number[] = [];
    const huge = 'A'.repeat(210000);
    const shot = snap.captureCanvas({ width: 640, height: 360 }, () => dest(pixels(true), (type, quality) => {
      if (type !== 'image/webp') return png(tiny);
      qualities.push(quality ?? 0);
      return quality !== undefined && quality <= 0.52 ? webp(tiny) : webp(huge);
    }));
    assert.equal(shot.ok, true);
    assert.equal(shot.type, 'image/webp');
    assert.ok(qualities[0] > 0.52);
    assert.ok(qualities.some((q) => q <= 0.52));
  });

  test('asks for an upload when the preview stays over 150 KB', () => {
    const huge = 'A'.repeat(210000);
    const shot = snap.captureCanvas({ width: 64, height: 36 }, () => dest(pixels(true), () => webp(huge)));
    assert.equal(shot.ok, false);
    assert.equal(shot.reason, 'oversize');
    assert.match(snap.snapshotError('oversize'), /150 KB/);
  });

  test('does not capture or set preserveDrawingBuffer without the preview flag', () => {
    const live = bootFrame({ search: '?embed=https%3A%2F%2Fportal.example' });
    const attrs = { alpha: false, preserveDrawingBuffer: false };
    live.canvas().getContext('webgl2', attrs);
    live.canvas().getContext('webgl', { alpha: true });
    assert.equal(attrs.preserveDrawingBuffer, false);
    assert.equal(live.getContextCalls[0]?.attrs?.preserveDrawingBuffer, false);
    assert.equal('preserveDrawingBuffer' in (live.getContextCalls[1]?.attrs ?? {}), false);
    live.ready();
    live.ready();
    live.requestAnimationFrame(() => {});
    live.flush();
    live.flush();
    assert.equal(live.posts.some((msg) => msg.type === '__MG_READY'), true);
    assert.equal(live.posts.some((msg) => msg.type === '__MG_FIRST_FRAME'), true);
    assert.equal(live.posts.some((msg) => msg.type === '__MG_SNAPSHOT'), false);
    assert.equal(live.timeouts.size, 0);

    const spoofed = bootFrame({ preview: 'true' });
    spoofed.canvas().getContext('webgl', {});
    spoofed.ready();
    spoofed.flush();
    assert.equal(spoofed.getContextCalls[0]?.attrs?.preserveDrawingBuffer, undefined);
    assert.equal(spoofed.posts.some((msg) => msg.type === '__MG_SNAPSHOT'), false);
  });

  test('upload preview forces preserveDrawingBuffer and posts a snapshot', () => {
    const preview = bootFrame({ preview: true });
    const attrs = { alpha: false, preserveDrawingBuffer: false };
    preview.canvas().getContext('webgl', attrs);
    preview.canvas().getContext('2d', { alpha: true });
    assert.equal(attrs.preserveDrawingBuffer, false);
    assert.equal(preview.getContextCalls[0]?.attrs?.preserveDrawingBuffer, true);
    assert.equal(preview.getContextCalls[0]?.attrs?.alpha, false);
    assert.deepEqual(preview.getContextCalls[1]?.attrs, { alpha: true });
    preview.ready();
    preview.flush();
    assert.equal(preview.posts.some((msg) => msg.type === '__MG_SNAPSHOT'), true);
  });

  test('forces preserveDrawingBuffer on WebGL contexts without changing 2d', () => {
    const caller = { alpha: false, preserveDrawingBuffer: false };
    const gl = snap.glContextAttrs('webgl2', caller);
    assert.equal(gl.attrs?.preserveDrawingBuffer, true);
    assert.equal(caller.preserveDrawingBuffer, false);
    assert.equal(gl.attrs?.alpha, false);
    assert.deepEqual(snap.glContextAttrs('2d', { alpha: true }), { type: '2d', attrs: { alpha: true } });
    assert.equal(snap.glContextAttrs('experimental-webgl', undefined).attrs?.preserveDrawingBuffer, true);
  });
});
