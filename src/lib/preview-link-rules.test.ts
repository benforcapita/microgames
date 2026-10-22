import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PREVIEW_LINK_TTL_HOURS, PREVIEW_LINK_TTLS, expiresIn, parsePreviewLinkTtl, shareTarget } from './preview-link-rules.ts';

describe('parsePreviewLinkTtl', () => {
  it('defaults to 24 hours when no lifetime is sent', () => {
    assert.equal(DEFAULT_PREVIEW_LINK_TTL_HOURS, 24);
    for (const missing of [undefined, null, '']) assert.equal(parsePreviewLinkTtl(missing), 24);
  });
  it('accepts exactly the offered lifetimes, as numbers or strings', () => {
    assert.deepEqual(PREVIEW_LINK_TTLS.map((t) => t.hours), [1, 24, 72, 168]);
    for (const { hours } of PREVIEW_LINK_TTLS) {
      assert.equal(parsePreviewLinkTtl(hours), hours);
      assert.equal(parsePreviewLinkTtl(String(hours)), hours);
    }
  });
  it('refuses anything else, including values the database would accept', () => {
    for (const bad of [0, -1, 2, 12, 169, 720, 1.5, NaN, Infinity, '24h', 'abc', true, {}, []]) {
      assert.equal(parsePreviewLinkTtl(bad), null, String(bad));
    }
  });
});

describe('shareTarget', () => {
  const v = (version: number, status: string) => ({ id: `v${version}-${status}`, version, status });

  it('is not found when nothing has been validated yet', () => {
    assert.deepEqual(shareTarget('pending', []), { kind: 'blocked', status: 404, message: 'Not found' });
  });
  it('only shares a game that is waiting for approval', () => {
    for (const stage of ['proving', 'live']) {
      assert.deepEqual(shareTarget(stage, [v(1, 'passed')]), {
        kind: 'blocked', status: 409, message: 'This game is already public. Share its page instead.',
      });
    }
    assert.deepEqual(shareTarget('rejected', [v(1, 'passed')]), {
      kind: 'blocked', status: 409, message: 'This game was rejected. Upload a fixed version to share it.',
    });
  });
  it('pins the newest passed version, even when a newer upload failed', () => {
    assert.deepEqual(shareTarget('pending', [v(3, 'failed'), v(2, 'passed'), v(1, 'passed')]), { kind: 'ok', versionId: 'v2-passed', version: 2 });
  });
  it('falls back to a version still being checked', () => {
    assert.deepEqual(shareTarget('pending', [v(1, 'running')]), { kind: 'ok', versionId: 'v1-running', version: 1 });
    assert.deepEqual(shareTarget('pending', [v(2, 'error'), v(1, 'queued')]), { kind: 'ok', versionId: 'v1-queued', version: 1 });
  });
  it('refuses when every version failed or errored', () => {
    assert.deepEqual(shareTarget('pending', [v(2, 'error'), v(1, 'failed')]), {
      kind: 'blocked', status: 409, message: 'This version failed its checks. Upload a fixed version to share it.',
    });
  });
});

describe('expiresIn', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  it('describes each offered lifetime right after creation', () => {
    assert.equal(expiresIn(at(3_600_000), now), 'Expires in 1 hour');
    assert.equal(expiresIn(at(24 * 3_600_000), now), 'Expires in 24 hours');
    assert.equal(expiresIn(at(72 * 3_600_000), now), 'Expires in 3 days');
    assert.equal(expiresIn(at(168 * 3_600_000), now), 'Expires in 7 days');
  });
  it('counts minutes under an hour and says expired at or past the end', () => {
    assert.equal(expiresIn(at(59 * 60_000 + 1), now), 'Expires in 1 hour');
    assert.equal(expiresIn(at(45 * 60_000), now), 'Expires in 45 min');
    assert.equal(expiresIn(at(30_000), now), 'Expires in 1 min');
    assert.equal(expiresIn(at(0), now), 'Expired');
    assert.equal(expiresIn(at(-1), now), 'Expired');
    assert.equal(expiresIn('not a date', now), 'Expired');
  });
});
