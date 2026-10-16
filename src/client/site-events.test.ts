import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSiteEvent } from '../lib/server/site-events.ts';
import { errorDetails, MAX_MESSAGE, MAX_STACK, scrub, scrubPath, sendSiteEvent } from './site-events.ts';

function withGlobals(g: { beacon?: ((u: string, b: Blob) => boolean) | 'throw' | null; fetch?: (u: string, i: RequestInit) => Promise<Response> }, fn: () => void) {
  const saved = { navigator: globalThis.navigator, fetch: globalThis.fetch, location: (globalThis as any).location };
  const nav: Record<string, unknown> = {};
  if (g.beacon === 'throw') nav.sendBeacon = () => { throw new TypeError('blocked'); };
  else if (g.beacon) nav.sendBeacon = g.beacon;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { pathname: '/games' }, configurable: true });
  globalThis.fetch = (g.fetch ?? (async () => new Response(null, { status: 204 }))) as typeof fetch;
  try { fn(); } finally {
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
    Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true });
    globalThis.fetch = saved.fetch;
  }
}

describe('LG-1b client site events', () => {
  it('scrub removes emails, IPs, query strings and fragments, and truncates', () => {
    const s = scrub('fail for ann@example.com at https://x.test/cb?token=abc&email=a%40b.c#frag from 10.0.0.1 and fe80:0:0:0:1:2:3:4', 500);
    assert.doesNotMatch(s, /@|token|abc|frag|10\.0\.0\.1|fe80/);
    assert.match(s, /\[email\]/);
    assert.match(s, /https:\/\/x\.test\/cb/);
    assert.equal(scrub('x'.repeat(1000), 50).length, 50);
    assert.equal(scrub(undefined, 10), '');
    assert.equal(scrubPath('/a'.repeat(400)).length, 512);
  });
  it('errorDetails is short, scrubbed and always accepted by the server parser', () => {
    const d = errorDetails('portal', `boom ${'m'.repeat(5000)} me@x.io`, `Error\n at f (https://site/p.js?sig=SECRET:1:2)\n${'  at g\n'.repeat(2000)}`);
    assert.ok(d.message.length <= MAX_MESSAGE && d.stack.length <= MAX_STACK);
    assert.doesNotMatch(JSON.stringify(d), /SECRET|me@x\.io/);
    const parsed = parseSiteEvent({ type: 'error', path: scrubPath('/play/x'), details: d });
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(errorDetails('game', undefined).message, 'unknown error');
  });
  it('uses sendBeacon (text/plain) when it queues, never fetch', () => {
    const sent: string[] = []; let fetched = 0;
    withGlobals({ beacon: (u, b) => (sent.push(`${u} ${b.type}`), true), fetch: async () => (fetched++, new Response(null)) }, () => sendSiteEvent('page_view'));
    assert.deepEqual(sent, ['/api/events text/plain;charset=utf-8']);
    assert.equal(fetched, 0);
  });
  it('falls back to fetch keepalive when sendBeacon is missing, refuses, or throws', () => {
    for (const beacon of [null, () => false, 'throw'] as const) {
      const calls: RequestInit[] = [];
      withGlobals({ beacon, fetch: async (_u, i) => (calls.push(i), new Response(null)) }, () => sendSiteEvent('game_launch', { gameId: 'g1' }));
      assert.equal(calls.length, 1, String(beacon));
      assert.equal(calls[0].keepalive, true);
      assert.deepEqual(JSON.parse(String(calls[0].body)), { type: 'game_launch', path: '/games', gameId: 'g1' });
    }
  });
  it('drops failures silently: rejecting fetch, throwing fetch, missing globals', async () => {
    let unhandled = 0; const h = () => unhandled++;
    process.on('unhandledRejection', h);
    withGlobals({ beacon: null, fetch: async () => { throw new TypeError('network'); } }, () => assert.doesNotThrow(() => sendSiteEvent('error', { details: { m: 1 } })));
    withGlobals({ beacon: null, fetch: (() => { throw new Error('sync'); }) as never }, () => assert.doesNotThrow(() => sendSiteEvent('page_view')));
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', h);
    assert.equal(unhandled, 0);
  });
});
