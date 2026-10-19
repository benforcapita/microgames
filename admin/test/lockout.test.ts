import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LockoutStore, PasswordVerifier } from '../src/lib/auth-basic.ts';
import { assertSecurityHeaders, runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD } from './helpers.ts';

const ENV = testEnv();
const GOOD = { authorization: basicAuth('boss', TEST_PASSWORD) };
const BAD = { authorization: basicAuth('boss', 'wrong-password') };

type FakeStore = {
  store: LockoutStore;
  calls: { check: number; record: number; clear: number };
};

// In-memory lockout store: reports `remaining` lock seconds and counts calls.
function fakeStore(remaining = 0, throwOn: 'check' | 'record' | 'clear' | null = null): FakeStore {
  const calls = { check: 0, record: 0, clear: 0 };
  return {
    calls,
    store: {
      async lockSecondsRemaining() {
        calls.check++;
        if (throwOn === 'check') throw new Error('db down');
        return remaining;
      },
      async recordFailure() {
        calls.record++;
        if (throwOn === 'record') throw new Error('db down');
      },
      async clearFailures() {
        calls.clear++;
        if (throwOn === 'clear') throw new Error('db down');
      },
    },
  };
}

function countingVerify(): { verify: PasswordVerifier; calls: () => number } {
  let calls = 0;
  return { verify: async () => (calls++, false), calls: () => calls };
}

test('lockout: a locked store → 429 text/plain with Retry-After, no challenge', async () => {
  const { store } = fakeStore(600);
  const { response, logs } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }),
    ENV,
    { store },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), 'Too many requests');
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('retry-after'), '600');
  assertSecurityHeaders(response);
  assert.ok(logs.some((l) => l.lock === 2), 'failed lock must be logged as lock 2');
});

test('lockout: Retry-After is ceil(remaining), capped at 900, minimum 1', async () => {
  for (const [remaining, expected] of [
    [899.2, '900'],
    [899.6, '900'],
    [10000, '900'], // cap
    [0.01, '1'], // minimum
    [60, '60'],
  ] as const) {
    const { store } = fakeStore(remaining);
    const { response } = await runRequest(
      new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }),
      ENV,
      { store },
    );
    assert.equal(response.status, 429, `remaining=${remaining}`);
    assert.equal(response.headers.get('retry-after'), expected, `remaining=${remaining}`);
  }
});

test('lockout: during a lock the password is not checked and no failure row is written', async () => {
  const { store, calls } = fakeStore(300);
  const { verify, calls: verifyCalls } = countingVerify();
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }),
    ENV,
    { store, verify },
  );
  // Even the correct password stays locked out.
  assert.equal(response.status, 429);
  assert.equal(verifyCalls(), 0, 'the password hash must not run during a lock');
  assert.equal(calls.record, 0, 'no failure row during a lock');
  assert.equal(calls.clear, 0, 'no clear during a lock');
});

test('lockout: no lock + wrong password → 401 and exactly one recorded failure', async () => {
  const { store, calls } = fakeStore(0);
  const { response } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }),
    ENV,
    { store },
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Basic realm="admin", charset="UTF-8"');
  assert.equal(calls.record, 1);
  assert.equal(calls.clear, 0);
});

test('lockout: no Basic credentials → 401 without recording a failure', async () => {
  const { store, calls } = fakeStore(0);
  const { verify, calls: verifyCalls } = countingVerify();
  const headerCases: Record<string, string>[] = [
    {},
    { authorization: 'Bearer abc' },
    { authorization: 'Basic !!!notbase64' },
    { authorization: 'Basic ' + Buffer.from('nopasswordcolon').toString('base64') },
  ];
  for (const headers of headerCases) {
    const { response } = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers }), ENV, {
      store,
      verify,
    });
    assert.equal(response.status, 401);
  }
  assert.equal(calls.record, 0, 'requests that present no Basic credentials record no row');
  // Timing parity is unchanged: the verify still ran for every probe.
  assert.equal(verifyCalls(), 4);
});

test('lockout: a correct login clears all failure rows', async () => {
  const { store, calls } = fakeStore(0);
  const { response } = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }), ENV, {
    store,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.clear, 1);
  assert.equal(calls.record, 0);
});

test('lockout: a store error on the lock check fails closed as a plain 503', async () => {
  const { store } = fakeStore(0, 'check');
  const { verify, calls: verifyCalls } = countingVerify();
  const { response, logs } = await runRequest(
    new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }),
    ENV,
    { store, verify },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), 'Service unavailable');
  assertSecurityHeaders(response);
  assert.equal(verifyCalls(), 0, 'the hash must not run when the store cannot answer');
  const line = logs.find((l) => l.error);
  assert.ok(line, 'expected an error log line');
  assert.doesNotMatch(String(line.error), /db down|postgres:\/\//, 'log must not carry the DB error detail or URL');
});

test('lockout: a store error recording or clearing a failure also fails closed', async () => {
  const badRecord = fakeStore(0, 'record');
  const r1 = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers: BAD }), ENV, {
    store: badRecord.store,
  });
  assert.equal(r1.response.status, 503);
  const badClear = fakeStore(0, 'clear');
  const r2 = await runRequest(new Request(`http://localhost/${TEST_SECRET}`, { headers: GOOD }), ENV, {
    store: badClear.store,
  });
  assert.equal(r2.response.status, 503);
});
