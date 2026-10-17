// GA-2: the real POST /api/auth/google route accepts the live domain and rejects the dead meshground.com one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test';
process.env.SUPABASE_SECRET_KEY ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// The route reads the Google provider flag from Supabase Auth settings at request time; answer "enabled".
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ external: { google: true } })) as typeof fetch;
const { POST } = await import('../../pages/api/auth/google.ts');
globalThis.fetch = realFetch;

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?x=1';

async function post(url: string, origin: string) {
  const calls: { redirectTo: string }[] = [];
  const auth = {
    async signInWithOAuth(args: { options: { redirectTo: string } }) {
      calls.push(args.options);
      return { data: { url: GOOGLE }, error: null };
    },
  };
  const request = new Request(url, { method: 'POST', headers: { origin }, body: new URLSearchParams({ next: '/me' }) });
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await POST({
      request,
      url: new URL(url),
      locals: { supabase: { auth } },
      redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    } as never);
    return { status: res.status, location: res.headers.get('location') ?? '', calls };
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe('GA-2 POST /api/auth/google origin allowlist', () => {
  it('accepts Origin https://www.meshground.app and sends Google back to that origin', async () => {
    for (const url of ['https://www.meshground.app/api/auth/google', 'http://localhost:3000/api/auth/google']) {
      const r = await post(url, 'https://www.meshground.app');
      assert.equal(r.status, 303, url);
      assert.equal(r.location, GOOGLE, url);
      assert.deepEqual(r.calls, [{ redirectTo: 'https://www.meshground.app/auth/callback?next=%2Fme' }], url);
    }
  });

  it('rejects Origin https://meshground.com with bad_origin and never calls Supabase', async () => {
    for (const url of ['https://meshground.com/api/auth/google', 'http://localhost:3000/api/auth/google']) {
      const r = await post(url, 'https://meshground.com');
      assert.equal(r.status, 303, url);
      assert.equal(new URL(r.location, 'https://x').searchParams.get('error'), 'bad_origin', url);
      assert.equal(r.calls.length, 0, url);
    }
  });
});
