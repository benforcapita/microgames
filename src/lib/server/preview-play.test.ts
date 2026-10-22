import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

function loopbackDatabaseUrl(): void {
  const fallback = 'postgresql://postgres:postgres@127.0.0.1:1/postgres';
  const current = process.env.DATABASE_URL;
  if (!current) {
    process.env.DATABASE_URL = fallback;
    return;
  }
  try {
    const host = new URL(current).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return;
  } catch {
    process.env.DATABASE_URL = fallback;
    return;
  }
  process.env.DATABASE_URL = fallback;
}

loopbackDatabaseUrl();
process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';
process.env.SUPABASE_SECRET_KEY ??= 'test-secret';

const { openPreviewLink } = await import('./preview-play.ts');
const { sql } = await import('./db.ts');

describe('preview play failure log', () => {
  it('logs the stage and postgres code without the token, address, or secret', async () => {
    const token = 'marker-token';
    const ip = 'lane-log';
    const secret = 'mg-test-secret';
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    const begin = mock.method(sql, 'begin', () => {
      throw Object.assign(new Error(`failed token ${token} ip ${ip} secret ${secret}`), { code: '42501' });
    });
    try {
      const outcome = await openPreviewLink({ token, ip, previewSecret: secret });
      assert.equal(outcome.kind, 'error');
      assert.deepEqual(logs, [['preview play failed stage=admit code=42501']]);
    } finally {
      begin.mock.restore();
      console.error = original;
    }
  });
});
