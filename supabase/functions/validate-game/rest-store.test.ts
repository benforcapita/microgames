// N6c: the REST store omits p_manual_review so record_game_validation reads
// manual_review_enabled(). An env flag must not appear in the request.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createRestStore } from './rest-store.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MG_MANUAL_REVIEW;
});

describe('validate-game REST store', () => {
  it('does not send p_manual_review, even when the env flag is off', async () => {
    process.env.MG_MANUAL_REVIEW = '0';
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify([{
        id: '00000000-0000-4000-8000-000000000001',
        status: 'passed',
        bundle_sha256: 'ab',
        version: 1,
        stage: 'pending',
      }]));
    }) as typeof fetch;
    const store = createRestStore('http://sb.local', 'sb_secret_test');
    const report = { status: 'pass' as const, bytes: 1, checks: [] };
    await store.recordValidation({
      gameId: 'game0001',
      sha256: 'ab',
      status: 'passed',
      report,
      manualReview: false,
      nextStage: (stage) => stage,
    });
    await store.applyStoredVerdict('game0001', 'ab', false);
    assert.equal(bodies.length, 2);
    for (const body of bodies) assert.equal(body.includes('p_manual_review'), false, body);
  });
});
