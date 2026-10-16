import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleSiteEvent, type SiteEventInput } from '../lib/server/site-events.ts';
import { errorDetails, MAX_ERRORS_PER_PAGE, scrub, sendSiteEvent } from './site-events.ts';

type Loc = { pathname: string; search?: string; hash?: string };
/** Runs fn with browser globals faked; returns every body the page tried to send (beacon or fetch). */
async function capture(fn: () => void | Promise<void>, { loc = { pathname: '/games' } as Loc, beacon = 'ok' as 'ok' | 'refuse' | 'throw' | 'none' } = {}) {
  const sent: { via: string; body: string; type?: string; keepalive?: boolean }[] = [];
  const saved = { navigator: globalThis.navigator, fetch: globalThis.fetch, location: (globalThis as any).location };
  const nav: Record<string, unknown> = {};
  if (beacon !== 'none') nav.sendBeacon = (_u: string, b: Blob) => {
    if (beacon === 'throw') throw new TypeError('blocked');
    if (beacon === 'refuse') return false;
    b.text().then((t) => sent.push({ via: 'beacon', body: t, type: b.type }));
    return true;
  };
  const href = `https://meshground.test${loc.pathname}${loc.search ?? ''}${loc.hash ?? ''}`;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { ...new URL(href), pathname: loc.pathname, search: loc.search ?? '', hash: loc.hash ?? '', href }, configurable: true });
  globalThis.fetch = (async (_u: string, i: RequestInit) => { sent.push({ via: 'fetch', body: String(i.body), keepalive: i.keepalive }); return new Response(null, { status: 204 }); }) as typeof fetch;
  try { await fn(); await new Promise((r) => setTimeout(r, 5)); } finally {
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
    Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true });
    globalThis.fetch = saved.fetch;
  }
  return sent;
}

/** What the real server handler would store for a client body (fake DB). */
async function serverStores(body: string): Promise<{ status: number; row?: SiteEventInput }> {
  let row: SiteEventInput | undefined;
  const res = await handleSiteEvent(new Request('http://x/api/events', { method: 'POST', body }), { ip: 'i', userId: null },
    { write: async (e) => { row = e; }, limiter: { hit: () => true } });
  return { status: res.status, row };
}

describe('client path: never the query string or hash', () => {
  it('a page at /games?email=ben%40example.com#tok sends path "/games"', async () => {
    const sent = await capture(() => sendSiteEvent('page_view'), { loc: { pathname: '/games', search: '?email=ben%40example.com&ref=x', hash: '#tok' } });
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].body).path, '/games');
  });
  it('query strings inside error text are stripped too', () => {
    assert.equal(scrub('at https://x.test/cb?token=abc#frag', 500), 'at https://x.test/cb');
  });
});

describe('client scrub uses the server PII detector', () => {
  const PII = ['ben@example.com', 'ben%40example.com', 'ben%2540example.com', 'ben%2Bx%40example.com', '2001:db8::1', '::1', 'fe80::1', '::ffff:cb00:7109', '203.0.113.9', 'ben[at]example.com'];
  for (const v of PII) it(`redacts ${v} and the server then stores the event (204, not 400)`, async () => {
    const d = errorDetails('portal', `failed for ${v} here`, `Error: ${v}\n    at main.js:3:14`);
    assert.ok(!JSON.stringify(d).includes(v));
    const sent = await capture(() => sendSiteEvent('error', { details: d }));
    const r = await serverStores(sent[0].body);
    assert.equal(r.status, 204);
    assert.match(String(r.row?.details.message), /^failed for \[redacted\] here$/);
  });
});

describe('decimal-integer IPv4: consistent with the server URL-only rule', () => {
  it('a 10-digit timestamp in an error message is sent as-is and stored', async () => {
    const d = errorDetails('portal', 'crash at 1760598000', 'Error: crash at 1760598000\n    at main.js:3:14');
    assert.equal(d.message, 'crash at 1760598000');
    const sent = await capture(() => sendSiteEvent('error', { details: d }));
    const r = await serverStores(sent[0].body);
    assert.equal(r.status, 204);
    assert.equal(r.row?.details.message, 'crash at 1760598000');
  });
  it('an integer-IPv4 path segment is redacted, so the page_view is stored instead of refused', async () => {
    const sent = await capture(() => sendSiteEvent('page_view'), { loc: { pathname: '/u/3405803777/x', search: '?ip=3405803777' } });
    const r = await serverStores(sent[0].body);
    assert.equal(r.status, 204);
    assert.equal(r.row?.path, '/u/[redacted]/x');
  });
});

describe('client truncation: UTF-8 bytes on code-point boundaries, always accepted', () => {
  const long: Record<string, string> = { ascii: 'x', latin: 'é', cjk: '漢', emoji: '😀', mixedOdd: 'a😀' };
  for (const [name, ch] of Object.entries(long)) it(`${name}: long message+stack is stored truncated, never 400 or dropped`, async () => {
    const d = errorDetails('portal', ch.repeat(5000), `Error\n${`    at f (${ch.repeat(40)}.js:1:2)\n`.repeat(500)}`);
    const sent = await capture(() => sendSiteEvent('error', { path: '/' + ch.repeat(2000), details: d }));
    const r = await serverStores(sent[0].body);
    assert.equal(r.status, 204, `${name}: server answered ${r.status}`);
    const msg = String(r.row?.details.message);
    assert.ok(msg.endsWith('…') && msg.length > 50, 'truncated, not emptied');
    assert.ok(!/[\uD800-\uDFFF]/.test(msg.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'no lone surrogate');
    assert.ok(!String(r.row?.details.message).includes('\uFFFD'), 'nothing had to be repaired');
    assert.ok((r.row?.path ?? '').length <= 512);
  });
});

describe('portal hooks', () => {
  class FakeErrorEvent extends Event { message: string; error: Error; constructor(m: string) { super('error'); this.message = m; this.error = new Error(m); } }
  async function freshInstall() {
    const win = new EventTarget();
    const saved = { window: (globalThis as any).window, ErrorEvent: (globalThis as any).ErrorEvent };
    (globalThis as any).window = win;
    (globalThis as any).ErrorEvent = FakeErrorEvent;
    const mod = await import(`./site-events.ts?fresh=${Math.random()}`);
    return { win, mod, restore: () => Object.assign(globalThis, saved) };
  }
  it(`sends one page_view and at most ${MAX_ERRORS_PER_PAGE} errors per page`, async () => {
    const { win, mod, restore } = await freshInstall();
    try {
      const sent = await capture(() => {
        mod.installPortalEvents();
        for (let i = 0; i < 12; i++) win.dispatchEvent(new FakeErrorEvent(`boom ${i}`));
      });
      const types = sent.map((s) => JSON.parse(s.body).type);
      assert.deepEqual(types, ['page_view', 'error', 'error', 'error', 'error', 'error']);
    } finally { restore(); }
  });
  it('sends another page_view on a bfcache restore (pageshow persisted), not on a normal pageshow', async () => {
    const { win, mod, restore } = await freshInstall();
    try {
      const show = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted });
      const sent = await capture(() => {
        mod.installPortalEvents();
        win.dispatchEvent(show(false));
        win.dispatchEvent(show(true));
      });
      assert.deepEqual(sent.map((s) => JSON.parse(s.body).type), ['page_view', 'page_view']);
    } finally { restore(); }
  });
});

describe('transport', () => {
  it('uses sendBeacon (text/plain) when it queues, never fetch', async () => {
    const sent = await capture(() => sendSiteEvent('page_view'));
    assert.deepEqual(sent.map((s) => `${s.via} ${s.type}`), ['beacon text/plain;charset=utf-8']);
  });
  it('falls back to fetch keepalive when sendBeacon is missing, refuses, or throws', async () => {
    for (const beacon of ['none', 'refuse', 'throw'] as const) {
      const sent = await capture(() => sendSiteEvent('game_launch', { gameId: 'g1' }), { beacon });
      assert.deepEqual(sent.map((s) => [s.via, s.keepalive]), [['fetch', true]], beacon);
      assert.deepEqual(JSON.parse(sent[0].body), { type: 'game_launch', path: '/games', gameId: 'g1' });
    }
  });
  it('drops failures silently', async () => {
    let unhandled = 0; const h = () => unhandled++;
    process.on('unhandledRejection', h);
    const saved = globalThis.fetch;
    await capture(() => {
      globalThis.fetch = (async () => { throw new TypeError('network'); }) as never;
      assert.doesNotThrow(() => sendSiteEvent('error', { details: { m: 1 } }));
      globalThis.fetch = (() => { throw new Error('sync'); }) as never;
      assert.doesNotThrow(() => sendSiteEvent('page_view'));
    }, { beacon: 'none' });
    globalThis.fetch = saved;
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', h);
    assert.equal(unhandled, 0);
  });
});
