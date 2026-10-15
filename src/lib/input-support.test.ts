import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DECLARABLE_INPUT_SUPPORT, INPUT_SUPPORT, INPUT_SUPPORT_META, parseDeclaredInputSupport, toInputSupport } from './input-support.ts';

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
function bootRuntime(metaContent: string | null) {
  const posted: Record<string, unknown>[] = [];
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop, construct: () => noop });
  const document: any = new Proxy({
    querySelector: (sel: string) => (sel === `meta[name="${INPUT_SUPPORT_META}"]` && metaContent !== null ? { getAttribute: () => metaContent } : null),
    addEventListener() {}, visibilityState: 'visible', cookie: '',
  }, { get: (t: any, k) => (k in t ? t[k] : noop) });
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const base: any = {
    document, parent, location: { hash: '', search: '', href: 'https://cdn.example/g/x/index.html' },
    performance: { now: () => 1 }, Date, Math, JSON, Object, Array, String, Number, Promise, Map, Set, Error, Symbol, Boolean, RegExp,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    Event: class {}, ErrorEvent: class {}, __mgBoot: false, __MG_PREVIEW: false, Meshgrounds: undefined,
  };
  const win: any = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true), has: () => true });
  base.window = win;
  base.self = win;
  base.globalThis = win;
  vm.runInNewContext(fs.readFileSync(new URL('../../cdn/boot.js', import.meta.url), 'utf8'), win);
  return { mg: base.Meshgrounds, posted };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v)); // objects from the vm realm

describe('runtime contract: Meshgrounds.declare / inputSupport (cdn/boot.js)', () => {
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
