import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import argon2 from '@node-rs/argon2';
import { checkBasicAuth } from '../src/lib/auth-basic.ts';
import { runRequest, testEnv, basicAuth, TEST_SECRET, TEST_PASSWORD, TEST_HASH } from './helpers.ts';

const ENV = testEnv();
const EXPECTED_CHALLENGE = 'Basic realm="admin", charset="UTF-8"';

function authedRequest(headers: Record<string, string> = {}) {
  return new Request(`http://localhost/${TEST_SECRET}`, { headers });
}

test('lock 2: no Authorization header → 401 with the admin realm challenge', async () => {
  const { response, logs } = await runRequest(authedRequest(), ENV);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), EXPECTED_CHALLENGE);
  assert.ok(logs.some((l) => l.lock === 2), 'expected the failed lock to be logged');
});

test('lock 2: wrong password → 401', async () => {
  const { response } = await runRequest(authedRequest({ authorization: basicAuth('boss', 'nope') }), ENV);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), EXPECTED_CHALLENGE);
});

test('lock 2: wrong user → 401', async () => {
  const { response } = await runRequest(
    authedRequest({ authorization: basicAuth('intruder', TEST_PASSWORD) }),
    ENV,
  );
  assert.equal(response.status, 401);
});

test('lock 2: malformed Authorization headers → 401', async () => {
  for (const header of [
    'Bearer abc',
    'Basic !!!notbase64',
    'Basic ' + Buffer.from('nopasswordcolon').toString('base64'),
    '',
  ]) {
    const { response } = await runRequest(authedRequest({ authorization: header }), ENV);
    assert.equal(response.status, 401, header);
  }
  // Scheme spelling is case-insensitive (RFC 9110): lowercase 'basic' with
  // correct credentials must still authenticate.
  const { response } = await runRequest(
    authedRequest({ authorization: 'basic ' + Buffer.from(`boss:${TEST_PASSWORD}`).toString('base64') }),
    ENV,
  );
  assert.equal(response.status, 200);
});

test('lock 2: correct credentials pass to the page', async () => {
  const { response } = await runRequest(
    authedRequest({ authorization: basicAuth('boss', TEST_PASSWORD) }),
    ENV,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/);
});

test('lock 2: password verify always runs, even on a user mismatch', async () => {
  let calls = 0;
  const countingVerify = async (hash: string, password: string) => {
    calls++;
    return argon2.verify(hash, password);
  };
  const cfg = { user: 'boss', passwordHash: TEST_HASH };
  // wrong user, right password -> verify still invoked
  await checkBasicAuth(basicAuth('someone-else', TEST_PASSWORD), cfg, countingVerify);
  assert.equal(calls, 1);
  // no Authorization header at all -> verify still invoked
  await checkBasicAuth(null, cfg, countingVerify);
  assert.equal(calls, 2);
});

test('lock 2: bcrypt $2b$ hashes verify too', async () => {
  const bcryptHash = bcrypt.hashSync(TEST_PASSWORD, 10);
  assert.ok(bcryptHash.startsWith('$2b$'));
  const env = testEnv({ ADMIN_PASSWORD_HASH: bcryptHash });
  const ok = await runRequest(authedRequest({ authorization: basicAuth('boss', TEST_PASSWORD) }), env);
  assert.equal(ok.response.status, 200);
  const bad = await runRequest(authedRequest({ authorization: basicAuth('boss', 'wrong') }), env);
  assert.equal(bad.response.status, 401);
});
