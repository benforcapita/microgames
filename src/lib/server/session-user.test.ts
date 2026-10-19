import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionUserId } from './session-user.ts';
import * as sessionUser from './session-user.ts';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A well-formed JWT-shaped string (locally made-up test data, not a real token). */
const jwt = (payload: Record<string, unknown>) =>
  `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}.${b64('sig')}`;

/** An sb-*-auth-token cookie value in the `base64-` format @supabase/ssr writes. */
const sessionCookie = (accessToken: unknown, expiresAt = 4_000_000_000) =>
  `base64-${b64(JSON.stringify({ access_token: accessToken, refresh_token: 'rt', expires_at: expiresAt }))}`;

const GOOD_JWT = jwt({ sub: ID, exp: 4_000_000_000 });
const GOOD = `sb-test-auth-token=${sessionCookie(GOOD_JWT)}`;

// The parse check ships with the fix; until then fail on assertions, not import errors.
function parseableAuthCookie(header: string | null): boolean {
  assert.equal(typeof sessionUser.parseableAuthCookie, 'function', 'session-user.ts must export parseableAuthCookie');
  return sessionUser.parseableAuthCookie(header);
}

describe('sessionUserId', () => {
  it('returns a lowercase uuid for a signed-in subject', () => {
    assert.equal(sessionUserId(ID.toUpperCase()), ID);
  });

  it('returns null for anonymous and unusable claims', () => {
    assert.equal(sessionUserId(undefined), null);
    assert.equal(sessionUserId(null), null);
    assert.equal(sessionUserId(''), null);
    assert.equal(sessionUserId('not-a-uuid'), null);
  });
});

describe('parseableAuthCookie', () => {
  it('is false without an auth-token cookie', () => {
    assert.equal(parseableAuthCookie(null), false);
    assert.equal(parseableAuthCookie(''), false);
    assert.equal(parseableAuthCookie('mg_uid=abc'), false);
    assert.equal(parseableAuthCookie('other=1'), false);
  });

  it('ignores the PKCE verifier cookies', () => {
    assert.equal(parseableAuthCookie('sb-127-auth-token-code-verifier=xyz'), false);
    assert.equal(parseableAuthCookie('sb-127-auth-token-flows-code-verifier=xyz'), false);
    assert.equal(parseableAuthCookie('sb-127-auth-token-flow-abcdef12-code-verifier=xyz'), false);
  });

  it('rejects garbage cookie values', () => {
    assert.equal(parseableAuthCookie('sb-127-auth-token='), false);
    assert.equal(parseableAuthCookie('sb-127-auth-token=garbage'), false);
    assert.equal(parseableAuthCookie('sb-127-auth-token=base64-'), false);
    assert.equal(parseableAuthCookie('sb-127-auth-token=base64-%%%'), false);
    // base64url-decodes fine, but not to JSON
    assert.equal(parseableAuthCookie('sb-127-auth-token=base64-Z2FyYmFnZQ'), false);
  });

  it('rejects session JSON without a well-formed JWT access_token', () => {
    // wrong segment count
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie('a')}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie('a.b')}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie('a.b.c.d')}`), false);
    // a segment outside the base64url alphabet
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie('a!.b.c')}`), false);
    // header / payload decode but are not JSON objects
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie(`${b64('5')}.${b64('{"sub":"x"}')}.${b64('s')}`)}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie(`${b64('{"alg":"none"}')}.${b64('[1,2]')}.${b64('s')}`)}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie(`${b64('not json')}.${b64('{}')}.${b64('s')}`)}`), false);
    // access_token missing or not a string
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie(5)}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=base64-${b64('{"refresh_token":"r"}')}`), false);
    // the session value is not an object at all
    assert.equal(parseableAuthCookie(`sb-x-auth-token=base64-${b64('"just a string"')}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=base64-${b64('[1,2,3]')}`), false);
  });

  it('accepts a base64- session cookie under any project ref', () => {
    assert.equal(parseableAuthCookie(GOOD), true);
    assert.equal(parseableAuthCookie(`sb-kmigfqhtvmvwopvpjlca-auth-token=${sessionCookie(GOOD_JWT)}`), true);
    assert.equal(parseableAuthCookie(`mg_uid=x; ${GOOD}; other=2`), true);
  });

  it('accepts a well-formed but expired token — getClaims may still refresh it', () => {
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${sessionCookie(jwt({ sub: ID, exp: 1 }), 1)}`), true);
  });

  it('accepts a raw (legacy, non-base64) JSON session value', () => {
    const raw = JSON.stringify({ access_token: GOOD_JWT, refresh_token: 'r', expires_at: 4_000_000_000 });
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${encodeURIComponent(raw)}`), true);
    // but a raw non-JSON value is still garbage
    assert.equal(parseableAuthCookie('sb-x-auth-token=not-json'), false);
  });

  it('joins chunked cookies in index order, not header order', () => {
    const value = sessionCookie(GOOD_JWT);
    const mid = Math.floor(value.length / 2);
    const [c0, c1] = [value.slice(0, mid), value.slice(mid)];
    assert.equal(parseableAuthCookie(`sb-x-auth-token.0=${c0}; sb-x-auth-token.1=${c1}`), true);
    assert.equal(parseableAuthCookie(`sb-x-auth-token.1=${c1}; sb-x-auth-token.0=${c0}`), true);
  });

  it('rejects broken chunk sequences like the ssr combiner does', () => {
    const value = sessionCookie(GOOD_JWT);
    const mid = Math.floor(value.length / 2);
    const [c0, c1] = [value.slice(0, mid), value.slice(mid)];
    // .1 without .0 — the combiner never reaches it
    assert.equal(parseableAuthCookie(`sb-x-auth-token.1=${c1}`), false);
    // a gap at .1 leaves only the truncated .0
    assert.equal(parseableAuthCookie(`sb-x-auth-token.0=${c0}; sb-x-auth-token.2=${c1}`), false);
  });

  it('lets a present bare cookie win over its chunks', () => {
    const value = sessionCookie(GOOD_JWT);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=garbage; sb-x-auth-token.0=${value}`), false);
    assert.equal(parseableAuthCookie(`sb-x-auth-token=${value}; sb-x-auth-token.0=garbage`), true);
  });

  it('treats an empty bare value as absent and falls through to chunks', () => {
    assert.equal(parseableAuthCookie(`sb-x-auth-token=; sb-x-auth-token.0=${sessionCookie(GOOD_JWT)}`), true);
  });

  it('is true when any one of several auth cookies parses', () => {
    assert.equal(parseableAuthCookie(`sb-a-auth-token=garbage; ${GOOD}`), true);
  });
});
