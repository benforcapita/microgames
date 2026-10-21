import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLimiter } from './abuse.ts';
import { handleSiteEvent, type SiteEventInput } from './site-events.ts';

type Row = { event: SiteEventInput };

/** Drives the real POST /api/events handler with a fake DB that records what would be inserted. */
function harness(opts: { write?: (e: SiteEventInput) => Promise<void>; timeoutMs?: number; max?: number } = {}) {
  const rows: Row[] = [];
  const write = opts.write ?? (async (event: SiteEventInput) => { rows.push({ event }); });
  const limiter = createLimiter({ windowMs: 60_000, max: opts.max ?? 10_000 });
  const send = (body: unknown, { ip = '198.51.100.1', headers = {} }: { ip?: string; headers?: Record<string, string> } = {}) =>
    handleSiteEvent(
      new Request('http://x/api/events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
      { ip },
      { write, timeoutMs: opts.timeoutMs, limiter },
    );
  return { rows, send };
}

describe('POST /api/events: types', () => {
  it('stores error with 204', async () => {
    const h = harness();
    assert.equal((await h.send({ type: 'error', path: '/games', details: { m: 'x' } })).status, 204);
    assert.deepEqual(h.rows.map((r) => r.event.type), ['error']);
  });
  it('page_view and game_launch are gone: 400 and nothing stored', async () => {
    const h = harness();
    assert.equal((await h.send({ type: 'page_view', path: '/games' })).status, 400);
    assert.equal((await h.send({ type: 'game_launch', path: '/play/x', gameId: 'x' })).status, 400);
    assert.equal(h.rows.length, 0);
  });
  it('rejects trigger-only, unknown and malformed bodies with 400 and stores nothing', async () => {
    const h = harness();
    for (const type of ['sign_up', 'upload', 'PAGE_VIEW', ' page_view', '', 1, null]) assert.equal((await h.send({ type })).status, 400, String(type));
    for (const body of ['', '{', '[]', '"page_view"', '3']) assert.equal((await h.send(body)).status, 400, body);
    assert.equal(h.rows.length, 0);
  });
});

describe('POST /api/events: no user tracking', () => {
  it('a user id in the body is never passed to the write', async () => {
    const h = harness();
    const forged = '00000000-0000-0000-0000-000000000001';
    assert.equal((await h.send({ type: 'error', user_id: forged, userId: forged })).status, 204);
    assert.equal(JSON.stringify(h.rows).includes(forged), false);
  });
});

describe('POST /api/events: size caps', () => {
  const details = (bytes: number) => ({ m: 'x'.repeat(bytes - 8) }); // {"m":""} is 8 bytes
  it('path up to 512 characters', async () => {
    const h = harness();
    assert.equal((await h.send({ type: 'error', path: '/' + 'a'.repeat(511) })).status, 204);
    assert.equal((await h.send({ type: 'error', path: '/' + 'a'.repeat(512) })).status, 400);
  });
  it('details up to 4000 UTF-8 bytes (under the DB 4096 jsonb limit); multibyte counts as bytes', async () => {
    const h = harness();
    assert.equal((await h.send({ type: 'error', details: details(4000) })).status, 204);
    for (const n of [4001, 4085, 4096]) assert.equal((await h.send({ type: 'error', details: details(n) })).status, 400, `${n}B`);
    assert.equal((await h.send({ type: 'error', details: { m: 'é'.repeat(1997) } })).status, 400, '3994 chars but 4002 bytes');
    assert.equal((await h.send({ type: 'error', details: [1] })).status, 400);
    assert.equal(h.rows.length, 1);
  });
  it('a DB check violation (23514) is a 400, not a silent 204', async () => {
    const h = harness({ write: async () => { throw Object.assign(new Error('violates check constraint "site_events_details_check"'), { code: '23514' }); } });
    assert.equal((await h.send({ type: 'error', details: { a: 1 } })).status, 400);
  });
  it('413 counts UTF-8 bytes of the body, not characters', async () => {
    const h = harness();
    const body = (junk: string) => JSON.stringify({ type: 'error', junk });
    const base = Buffer.byteLength(body(''));
    assert.equal((await h.send(body('x'.repeat(6144 - base)))).status, 204, 'exactly 6144 bytes');
    assert.equal((await h.send(body('x'.repeat(6145 - base)))).status, 413, '6145 bytes');
    assert.equal((await h.send(body('€'.repeat(2100)))).status, 413, '~2.1K chars, ~6.3KB');
    assert.equal(h.rows.length, 1);
  });
  it('413 stops reading a streamed body once past the cap', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(1024).fill(0x20)); if (pulled > 1000) c.close(); },
    });
    const res = await handleSiteEvent(
      new Request('http://x/api/events', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      { ip: 'i' }, { write: async () => {}, limiter: { hit: () => true } },
    );
    assert.equal(res.status, 413);
    assert.ok(pulled < 20, `read ${pulled} KB before stopping`);
  });
});

describe('POST /api/events: unicode', () => {
  it('a lone surrogate is stored as U+FFFD instead of being dropped by jsonb', async () => {
    const h = harness();
    assert.equal((await h.send(JSON.stringify({ type: 'error', path: '/p\uD83D', details: { m: 'x\uD83D', ['k\uDE00']: 1 } }))).status, 204);
    assert.equal(h.rows[0].event.path, '/p\uFFFD');
    assert.deepEqual(h.rows[0].event.details, { m: 'x\uFFFD', ['k\uFFFD']: 1 });
  });
});

describe('POST /api/events: no emails or IPs stored', () => {
  const PII: Record<string, string> = {
    email: 'a.b@example.com', plus: 'ben+qa@example.com', upper: 'BEN@EXAMPLE.COM', idn: 'ben@exämple.de',
    urlenc: 'ben%40example.com', urlenc2: 'ben%2540example.com', urlenc3: 'ben%252540example.com', query: '/q?e=ben%2Bx%40example.com',
    badEncodingThenEmail: '%E0%A4%A ben%40x.com',
    spacedAt: 'ben at example.com', bracketAt: 'ben[at]example.com', parenAt: 'ben(at)example.com', atDot: 'ben (at) example dot com', wordAtDot: 'ben at example dot com',
    ipv4: '203.0.113.9', ipv4zero: '203.000.113.009',
    ipv6full: '2001:db8:0:0:0:0:0:1', ipv6comp: '2001:db8::1', ipv6loop: '::1', ipv6ll: 'fe80::1', ipv6zone: 'fe80::1%eth0', ipv6bracket: '[::1]:8080',
    mapped: '::ffff:203.0.113.9', mappedhex: '::ffff:cb00:7109', ipv6urlenc: '2001%3Adb8%3A%3A1',
  };
  for (const [name, v] of Object.entries(PII)) {
    it(`rejects ${name} (${v}) in details value, details key, nested value, path and gameId`, async () => {
      const h = harness();
      const bodies = [
        { type: 'error', details: { v } },
        { type: 'error', details: { [v]: 1 } },
        { type: 'error', details: { a: { b: [{ c: v }] } } },
        { type: 'error', path: `/qa/${v}` },
        { type: 'error', gameId: v },
      ];
      for (const b of bodies) assert.equal((await h.send(b)).status, 400, JSON.stringify(b));
      assert.equal(h.rows.length, 0);
    });
  }
  it('keeps ordinary game telemetry (stack traces, versions, ms timestamps, C++-style names)', async () => {
    const h = harness();
    const ok = ['TypeError: x is undefined\n    at main.js:3:14\n    at Object.run (game.js:10:2)', 'v1.2.3', '12:30:45', 'Foo::bar', 'score 12345', '100%', '%E0%A4%A', 1760000000000];
    for (const v of ok) assert.equal((await h.send({ type: 'error', path: '/games/space-at-night', details: { v } })).status, 204, String(v));
    assert.equal(h.rows.length, ok.length);
  });
});

describe('POST /api/events: decimal-integer IPv4 only in URL parts', () => {
  it('rejects ?ip=3405803777, a /3405803777 segment, and encoded variants; stores nothing', async () => {
    const h = harness();
    for (const path of ['/qa?ip=3405803777', '/qa?a=1&peer=3405803777', '/3405803777', '/u/3405803777/x', '/qa?ip=%33405803777', '/%2533405803777'])
      assert.equal((await h.send({ type: 'error', path })).status, 400, path);
    assert.equal(h.rows.length, 0);
  });
  it('stores 10-digit Unix timestamps in messages and details, and non-address numbers in paths', async () => {
    const h = harness();
    for (const body of [
      { type: 'error', details: { message: 'Error at 1760598000: boom', ts: 1760598000, t: '1760598000' } },
      { type: 'error', path: '/games/level-1760598000' },
      { type: 'error', path: '/games/1234567' },
      { type: 'error', path: '/games/99999999999' },
    ]) assert.equal((await h.send(body)).status, 204, JSON.stringify(body));
    assert.equal(h.rows.length, 4);
    assert.equal(h.rows[0].event.details.ts, 1760598000);
  });
});

describe('POST /api/events: preview links', () => {
  it('stores a preview crash without the link token', async () => {
    const h = harness();
    const token = 'abcDEF789_-'.repeat(4);
    const stack = `Error: boom\n    at https://meshground.test/p/${token}:1:1\n    at src/pages/p/[token].astro:12:3`;
    assert.equal((await h.send({ type: 'error', path: `/p/${token}`, gameId: 'pendingid', details: { message: 'boom', stack } })).status, 204);
    const stored = JSON.stringify(h.rows);
    assert.equal(stored.includes(token), false);
    assert.match(stored, /\/p\/\[redacted\]/);
    assert.match(stored, /src\/pages\/p\/\[token\]\.astro/);
  });
});

describe('POST /api/events: awaited, bounded write', () => {
  const ev = { type: 'error', path: '/x' };
  it('the row is written before the 204 is returned', async () => {
    let written = false;
    const h = harness({ write: async () => { await new Promise((r) => setTimeout(r, 50)); written = true; } });
    const res = await h.send(ev);
    assert.equal(res.status, 204);
    assert.equal(written, true);
  });
  it('a hung DB still answers 204 in ~1.5s', async () => {
    const h = harness({ write: () => new Promise(() => {}) });
    const t0 = performance.now();
    assert.equal((await h.send(ev)).status, 204);
    const ms = performance.now() - t0;
    assert.ok(ms >= 1400 && ms < 1800, `took ${Math.round(ms)}ms`);
  });
  it('a DB error answers 204 and does not throw', async () => {
    const h = harness({ write: async () => { throw new Error('connection refused'); } });
    assert.equal((await h.send(ev)).status, 204);
  });
  it('leaves no timer behind after a fast write', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const h = harness();
    const before = timers();
    for (let i = 0; i < 20; i++) await h.send(ev);
    assert.equal(timers(), before);
  });
  it('rate limits per IP: 60 per minute, other IPs unaffected', async () => {
    const h = harness({ max: 60 });
    const codes = [];
    for (let i = 0; i < 62; i++) codes.push((await h.send(ev, { ip: '192.0.2.1' })).status);
    assert.deepEqual([codes.filter((c) => c === 204).length, codes.filter((c) => c === 429).length], [60, 2]);
    assert.equal((await h.send(ev, { ip: '192.0.2.2' })).status, 204);
  });
});
