import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLimiter } from './abuse.ts';
import { readFileSync } from 'node:fs';
import { parseSiteEvent, recordSiteEventBounded, SITE_EVENT_MAX_PATH, SITE_EVENT_WRITE_TIMEOUT_MS, siteEventsByIp } from './site-events.ts';

describe('parseSiteEvent', () => {
  it('accepts page_view, game_launch and error', () => {
    for (const type of ['page_view', 'game_launch', 'error']) assert.equal(parseSiteEvent({ type, path: '/games' }).ok, true, type);
  });
  it('rejects trigger-only and unknown types', () => {
    for (const type of ['sign_up', 'upload', 'PAGE_VIEW', '', 'x', 1, null, undefined]) assert.equal(parseSiteEvent({ type }).ok, false, String(type));
    for (const body of [null, 'page_view', [], 3]) assert.equal(parseSiteEvent(body).ok, false);
  });
  it('caps path at 512 characters', () => {
    assert.equal(parseSiteEvent({ type: 'page_view', path: '/' + 'a'.repeat(SITE_EVENT_MAX_PATH - 1) }).ok, true);
    assert.equal(parseSiteEvent({ type: 'page_view', path: '/' + 'a'.repeat(SITE_EVENT_MAX_PATH) }).ok, false);
    assert.equal(parseSiteEvent({ type: 'page_view', path: 5 }).ok, false);
  });
  it('caps details at 4 KB of JSON and requires an object', () => {
    assert.equal(parseSiteEvent({ type: 'error', details: { m: 'x'.repeat(4000) } }).ok, true);
    assert.equal(parseSiteEvent({ type: 'error', details: { m: 'x'.repeat(4100) } }).ok, false);
    assert.equal(parseSiteEvent({ type: 'error', details: { m: 'é'.repeat(2100) } }).ok, false, 'bytes, not chars');
    assert.equal(parseSiteEvent({ type: 'error', details: [1] }).ok, false);
    assert.equal(parseSiteEvent({ type: 'error', details: 'str' }).ok, false);
  });
  it('rejects emails and IPs anywhere in the event', () => {
    assert.equal(parseSiteEvent({ type: 'error', details: { who: 'a.b@example.com' } }).ok, false);
    assert.equal(parseSiteEvent({ type: 'error', details: { ip: '203.0.113.9' } }).ok, false);
    assert.equal(parseSiteEvent({ type: 'error', details: { ip: '2001:db8:0:0:0:0:0:1' } }).ok, false);
    assert.equal(parseSiteEvent({ type: 'page_view', path: '/u/a@b.co' }).ok, false);
  });
  it('never takes user_id from the body', () => {
    const r = parseSiteEvent({ type: 'page_view', user_id: '00000000-0000-0000-0000-000000000001', userId: 'x' });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.event).sort(), ['details', 'gameId', 'path', 'type']);
  });
});

describe('per-IP rate limit', () => {
  it('allows 60 per minute per IP, then refuses; other IPs unaffected; window resets', () => {
    let t = 0;
    const lim = createLimiter({ windowMs: 60_000, max: 60, now: () => t });
    for (let i = 0; i < 60; i++) assert.equal(lim.hit('1.1.1.1'), true);
    assert.equal(lim.hit('1.1.1.1'), false);
    assert.equal(lim.hit('2.2.2.2'), true);
    t = 60_001;
    assert.equal(lim.hit('1.1.1.1'), true);
  });
  it('the shipped limiter is in-memory and allows a first hit', () => {
    assert.equal(siteEventsByIp.hit('test-ip-' + Math.random()), true);
  });
});

describe('recordSiteEventBounded (awaited insert, ~1.5s cap)', () => {
  const event = { type: 'page_view' as const, path: '/x', gameId: null, details: {} };

  it('resolves only after the insert has finished', async () => {
    const order: string[] = [];
    const write = async () => { await new Promise((r) => setTimeout(r, 50)); order.push('inserted'); };
    const out = await recordSiteEventBounded(event, null, { write });
    order.push('returned');
    assert.equal(out, 'ok');
    assert.deepEqual(order, ['inserted', 'returned']);
  });

  it('a slow DB returns "timeout" within ~1.5s instead of hanging', async () => {
    assert.equal(SITE_EVENT_WRITE_TIMEOUT_MS, 1500);
    const t0 = performance.now();
    const out = await recordSiteEventBounded(event, null, { write: () => new Promise(() => {}) });
    const ms = performance.now() - t0;
    assert.equal(out, 'timeout');
    assert.ok(ms >= 1400 && ms < 1800, `took ${Math.round(ms)}ms`);
  });

  it('a DB error is swallowed as "error"', async () => {
    assert.equal(await recordSiteEventBounded(event, null, { write: async () => { throw new Error('db down'); } }), 'error');
  });

  it('the route awaits the bounded insert before returning 204', () => {
    const src = readFileSync(new URL('../../pages/api/events.ts', import.meta.url), 'utf8');
    const awaitAt = src.indexOf('await recordSiteEventBounded(');
    assert.ok(awaitAt > 0, 'awaits recordSiteEventBounded');
    assert.ok(awaitAt < src.lastIndexOf('status: 204'), '204 comes after the await');
    assert.doesNotMatch(src, /recordSiteEvent\(/, 'no unbounded/un-awaited write');
  });
});
