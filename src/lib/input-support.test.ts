import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DECLARABLE_INPUT_SUPPORT, INPUT_SUPPORT, INPUT_SUPPORT_META, INPUT_SUPPORT_META_NAMES, LEGACY_INPUT_SUPPORT_META, parseDeclaredInputSupport, toInputSupport } from './input-support.ts';

describe('input support values', () => {
  it('matches the migration check constraint', () => {
    const sql = fs.readFileSync(new URL('../../supabase/migrations/20261015140000_input_support.sql', import.meta.url), 'utf8');
    assert.match(sql, /input_support text not null default 'unknown'/);
    assert.match(sql, /check \(input_support in \('mobile', 'desktop', 'both', 'unknown'\)\)/);
    assert.deepEqual([...INPUT_SUPPORT], ['mobile', 'desktop', 'both', 'unknown']);
  });
  it('parses declarations: only mobile/desktop/both, case and space insensitive', () => {
    for (const v of DECLARABLE_INPUT_SUPPORT) assert.equal(parseDeclaredInputSupport(v), v);
    assert.equal(parseDeclaredInputSupport(' Both '), 'both');
    assert.equal(parseDeclaredInputSupport('MOBILE'), 'mobile');
    for (const v of ['unknown', '', 'touch', 'keyboard', null, undefined, 1, {}]) assert.equal(parseDeclaredInputSupport(v), null, String(v));
  });
  it('maps stored values, defaulting anything odd to unknown', () => {
    for (const v of INPUT_SUPPORT) assert.equal(toInputSupport(v), v);
    for (const v of [null, undefined, 'Mobile', 'tablet', 3]) assert.equal(toInputSupport(v), 'unknown');
  });
});

/** Runs cdn/boot.js in a vm with a forgiving fake window (any unknown member is a no-op function). */
function bootRuntime(metaContent: string | null, metaName = INPUT_SUPPORT_META) {
  const posted: Record<string, unknown>[] = [];
  const events: string[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop, construct: () => noop });
  const document: any = new Proxy({
    querySelector: (sel: string) => (sel === `meta[name="${metaName}"]` && metaContent !== null ? { getAttribute: () => metaContent } : null),
    addEventListener() {}, visibilityState: 'visible', cookie: '',
  }, { get: (t: any, k) => (k in t ? t[k] : noop) });
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const base: any = {
    document, parent, location: { hash: '', search: '', href: 'https://cdn.example/g/x/index.html' },
    performance: { now: () => 1 }, Date, Math, JSON, Object, Array, String, Number, Promise, Map, Set, Error, Symbol, Boolean, RegExp,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, removeEventListener() {},
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatchEvent: (e: { type: string }) => events.push(e.type),
    Event: class { type: string; constructor(type: string) { this.type = type; } }, ErrorEvent: class {}, __mgBoot: false, __MG_PREVIEW: false, Meshground: undefined, Meshgrounds: undefined,
  };
  const win: any = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true), has: () => true });
  base.window = win;
  base.self = win;
  base.globalThis = win;
  vm.runInNewContext(fs.readFileSync(new URL('../../cdn/boot.js', import.meta.url), 'utf8'), win);
  return { mg: base.Meshground, legacy: base.Meshgrounds, posted, events, listeners, base };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v)); // objects from the vm realm

describe('runtime contract: Meshground.declare / inputSupport (cdn/boot.js)', () => {
  it('undeclared reads unknown', () => {
    assert.equal(bootRuntime(null).mg.inputSupport, 'unknown');
  });
  it('reads the meta tag', () => {
    assert.equal(bootRuntime('Mobile').mg.inputSupport, 'mobile');
    assert.equal(bootRuntime('nonsense').mg.inputSupport, 'unknown');
  });
  it('declare({ inputSupport }) wins over the meta tag, posts __MG_META once, ignores invalid values', () => {
    const { mg, posted } = bootRuntime('desktop');
    assert.deepEqual(plain(mg.declare({ inputSupport: 'both' })), { inputSupport: 'both' });
    assert.equal(mg.inputSupport, 'both');
    mg.declare({ inputSupport: 'both' });
    assert.deepEqual(plain(mg.declare({ inputSupport: 'joystick' })), { inputSupport: 'both' });
    assert.deepEqual(plain(mg.declare(null)), { inputSupport: 'both' });
    assert.deepEqual(plain(posted.filter((m) => m.type === '__MG_META')), [{ type: '__MG_META', inputSupport: 'both' }]);
  });
});

describe('pre-rebrand compatibility (games written against window.Meshgrounds)', () => {
  it('window.Meshgrounds is the same object as window.Meshground', () => {
    const { mg, legacy } = bootRuntime(null);
    assert.ok(mg && typeof mg.ready === 'function');
    assert.equal(legacy, mg);
  });
  it('the old meshgrounds:input-support meta tag is still read', () => {
    assert.equal(bootRuntime('desktop', LEGACY_INPUT_SUPPORT_META).mg.inputSupport, 'desktop');
    assert.deepEqual([...INPUT_SUPPORT_META_NAMES], ['meshground:input-support', 'meshgrounds:input-support']);
  });
  it('pause/resume fire both the new and the old event names', () => {
    const { base, events, listeners } = bootRuntime(null);
    const send = (type: string) => listeners.get('message')!.forEach((fn) => fn({ source: base.parent, data: { type } }));
    send('PAUSE');
    send('RESUME');
    assert.deepEqual(events, ['meshground:pause', 'meshgrounds:pause', 'meshground:resume', 'meshgrounds:resume']);
  });
});
