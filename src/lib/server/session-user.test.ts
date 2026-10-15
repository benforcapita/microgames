import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasAuthSessionCookie, sessionUserId } from './session-user.ts';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

describe('hasAuthSessionCookie', () => {
  it('detects a Supabase auth cookie and its chunks', () => {
    assert.equal(hasAuthSessionCookie(null), false);
    assert.equal(hasAuthSessionCookie(''), false);
    assert.equal(hasAuthSessionCookie('mg_uid=abc'), false);
    assert.equal(hasAuthSessionCookie('sb-127-auth-token=eyJ'), true);
    assert.equal(hasAuthSessionCookie('other=1; sb-microgames-auth-token.0=chunk'), true);
  });

  it('ignores the PKCE code-verifier cookie', () => {
    assert.equal(hasAuthSessionCookie('sb-127-auth-token-code-verifier=xyz'), false);
  });
});
