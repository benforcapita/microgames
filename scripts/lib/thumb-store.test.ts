import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restStore } from './thumb-store.mjs';

/** Tiny stand-in for a supabase-js client: records every builder call and answers from `respond`. */
function fakeClient(respond: (calls: [string, unknown[]][]) => { data: unknown; error: { message: string } | null }) {
  const log: [string, unknown[]][][] = [];
  const builder = () => {
    const calls: [string, unknown[]][] = [];
    log.push(calls);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'is', 'in', 'order', 'range', 'insert', 'upsert', 'delete'])
      b[m] = (...args: unknown[]) => (calls.push([m, args]), b);
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(respond(calls)).then(ok, bad);
    return b;
  };
  return { client: { from: (t: string) => (assert.equal(t, 'games'), builder()) }, log };
}
const names = (calls: [string, unknown[]][]) => calls.map(([m]) => m);

test('setThumb from null uses update … eq(id) is(thumb, null) select(id), and reports a win', async () => {
  const { client, log } = fakeClient(() => ({ data: [{ id: 'g1' }], error: null }));
  assert.equal(await restStore(client).setThumb('g1', null, 'thumb-abc.webp'), true);
  assert.deepEqual(log[0], [['update', [{ thumb: 'thumb-abc.webp' }]], ['eq', ['id', 'g1']], ['is', ['thumb', null]], ['select', ['id']]]);
});

test('setThumb over an existing value compares with eq(thumb, old)', async () => {
  const { client, log } = fakeClient(() => ({ data: [{ id: 'g1' }], error: null }));
  await restStore(client).setThumb('g1', 'thumb.webp', 'thumb-new.webp');
  assert.deepEqual(log[0][2], ['eq', ['thumb', 'thumb.webp']]);
});

test('setThumb reports a lost race when no row matched', async () => {
  const { client } = fakeClient(() => ({ data: [], error: null }));
  assert.equal(await restStore(client).setThumb('g1', null, 'thumb-x.webp'), false);
});

test('PostgREST errors throw (never treated as success)', async () => {
  const { client } = fakeClient(() => ({ data: null, error: { message: 'permission denied' } }));
  await assert.rejects(restStore(client).setThumb('g1', null, 'k'), /conditional update failed: permission denied/);
  await assert.rejects(restStore(client).list(['g1']), /select by id failed/);
});

test('list(ids) matches id OR slug, de-duplicates and orders by created_at', async () => {
  const rows = {
    id: [{ id: 'b', slug: 'bee', title: 'B', thumb: null, created_at: '2026-10-02T00:00:00+00:00' }],
    slug: [
      { id: 'b', slug: 'bee', title: 'B', thumb: null, created_at: '2026-10-02T00:00:00+00:00' },
      { id: 'a', slug: 'ay', title: 'A', thumb: 't', created_at: '2026-10-01T00:00:00+00:00' },
    ],
  };
  const { client, log } = fakeClient((calls) => ({ data: rows[calls.find(([m]) => m === 'in')![1][0] as 'id' | 'slug'], error: null }));
  const out = await restStore(client).list(['b', 'ay']);
  assert.deepEqual(out, [{ id: 'a', slug: 'ay', title: 'A', thumb: 't' }, { id: 'b', slug: 'bee', title: 'B', thumb: null }]);
  assert.deepEqual(log.map((c) => c.find(([m]) => m === 'in')), [['in', ['id', ['b', 'ay']]], ['in', ['slug', ['b', 'ay']]]]);
});

test('list(null) pages through every game 1000 at a time', async () => {
  const total = 2345;
  const { client, log } = fakeClient((calls) => {
    const [from, to] = calls.find(([m]) => m === 'range')![1] as [number, number];
    const data = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) data.push({ id: `g${String(i).padStart(5, '0')}`, slug: `s${i}`, title: 't', thumb: null, created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z` });
    return { data, error: null };
  });
  const out = await restStore(client).list(null);
  assert.equal(out.length, total);
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((c) => c.find(([m]) => m === 'range')![1]), [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('the REST store only ever writes through the conditional update', async () => {
  const { client, log } = fakeClient(() => ({ data: [], error: null }));
  const s = restStore(client);
  await s.list(['x']);
  await s.list(null);
  assert.ok(log.every((c) => !names(c).some((m) => ['update', 'insert', 'upsert', 'delete'].includes(m))));
  assert.deepEqual(Object.keys(s).sort(), ['end', 'kind', 'list', 'setThumb']);
});
