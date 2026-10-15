import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ratingUserId } from './game-rules.ts';

describe('ratingUserId (RT-2 expand: write voter and user_id)', () => {
  it('mirrors an auth user id into user_id', () => {
    assert.equal(ratingUserId('3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f'), '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f');
    assert.equal(ratingUserId('3F1C2A9E-8B7D-4C6E-9F00-1A2B3C4D5E6F'), '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f');
  });
  it('leaves user_id null for legacy non-account voters', () => {
    for (const v of ['', 'anon-abc', 'ip:1.2.3.4', '3f1c2a9e8b7d4c6e9f001a2b3c4d5e6f', '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f; drop table ratings'])
      assert.equal(ratingUserId(v), null, v);
  });
});
