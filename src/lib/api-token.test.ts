import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_TOKEN_PREFIX, apiTokenName, apiTokenPrefix, bearerToken, generateApiToken, hashApiToken, isTokenId } from './api-token.ts';

describe('API tokens', () => {
  it('generates unique prefixed tokens that bearerToken accepts', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    assert.notEqual(a, b);
    assert.ok(a.startsWith(API_TOKEN_PREFIX));
    assert.equal(bearerToken(`Bearer ${a}`), a);
    assert.equal(bearerToken(`bearer ${a}  `), a);
  });

  it('rejects missing, malformed and non-Bearer headers', () => {
    const t = generateApiToken();
    for (const h of [null, undefined, '', t, `Basic ${t}`, `Bearer ${t}x`, `Bearer ${t.slice(0, -1)}`, 'Bearer mgp_short', `Bearer ${t} extra`]) {
      assert.equal(bearerToken(h), null, String(h));
    }
  });

  it('hashes to stable sha256 hex and shows only a short prefix', () => {
    const t = generateApiToken();
    assert.match(hashApiToken(t), /^[0-9a-f]{64}$/);
    assert.equal(hashApiToken(t), hashApiToken(t));
    assert.equal(apiTokenPrefix(t).length, API_TOKEN_PREFIX.length + 6);
    assert.ok(t.startsWith(apiTokenPrefix(t)));
  });

  it('cleans token names and falls back to a default', () => {
    assert.equal(apiTokenName('  Claude   Desktop '), 'Claude Desktop');
    assert.equal(apiTokenName(''), 'MCP token');
    assert.equal(apiTokenName(null), 'MCP token');
    assert.equal(apiTokenName('x'.repeat(80)).length, 60);
  });

  it('accepts only uuid token ids', () => {
    assert.ok(isTokenId('9b2c7a52-3f7e-4f6b-9d0a-1c2b3d4e5f60'));
    assert.ok(!isTokenId('1; drop table api_tokens'));
  });
});
