import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servedBundleVersion } from './served-version.mjs';

const rows = [
  { version: 1, status: 'passed', finished_at: '2026-10-17T00:00:00.000Z' },
  { version: 2, status: 'passed', finished_at: '2026-10-18T01:00:00.000Z' },
];

describe('served bundle version', () => {
  it('keeps the approved version until reviewed_at moves past the new one', () => {
    assert.equal(servedBundleVersion({ preview: false, reviewedAt: '2026-10-18T00:00:00.000Z', rows }), 1);
    assert.equal(servedBundleVersion({ preview: false, reviewedAt: '2026-10-18T02:00:00.000Z', rows }), 2);
  });
  it('serves the latest version when the game was never reviewed', () => {
    assert.equal(servedBundleVersion({ preview: false, reviewedAt: null, rows }), 2);
  });
  it('lets an owner preview the latest version', () => {
    assert.equal(servedBundleVersion({ preview: true, reviewedAt: '2026-10-18T00:00:00.000Z', rows }), 2);
  });
  it('ignores a failed version newer than the review', () => {
    const mixed = [
      { version: 1, status: 'passed', finished_at: '2026-10-17T00:00:00.000Z' },
      { version: 2, status: 'failed', finished_at: '2026-10-18T03:00:00.000Z' },
    ];
    assert.equal(servedBundleVersion({ preview: false, reviewedAt: '2026-10-18T00:00:00.000Z', rows: mixed }), 1);
  });
});
