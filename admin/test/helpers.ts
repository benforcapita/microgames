import argon2 from '@node-rs/argon2';
import assert from 'node:assert/strict';
import { handleRequest, type Deps } from '../src/middleware.ts';
import type { LockoutStore } from '../src/lib/auth-basic.ts';
import { GET as robotsGet } from '../src/pages/robots.txt.ts';
import { GET as indexGet, POST as indexPost } from '../src/pages/[p]/index.ts';
import { GET as cssGet } from '../src/pages/[p]/admin.css.ts';
import { ALL as catchAll } from '../src/pages/[...any].ts';
import type { LogFields } from '../src/lib/log.ts';

// Minimal stand-in for Astro's router: dispatch the request to the real route
// modules exactly as src/pages would match them. Middleware under test still
// decides whether `next` is reached at all.
function routeNext(request: Request, locals: Record<string, unknown>) {
  return async (): Promise<Response> => {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const ctx = { request, params: { p: segments[0] }, locals, url } as never;
    if (url.pathname === '/robots.txt' && request.method === 'GET') return robotsGet(ctx);
    if (segments.length === 1) {
      if (request.method === 'GET') return indexGet(ctx);
      if (request.method === 'POST') return indexPost(ctx);
    }
    if (segments.length === 2 && segments[1] === 'admin.css' && request.method === 'GET') {
      return cssGet(ctx);
    }
    return catchAll(ctx);
  };
}

export type RunResult = { response: Response; locals: Record<string, unknown>; logs: LogFields[] };

// Unit tests that don't exercise the lockout inject this: never locked,
// record/clear are no-ops, so no database is needed.
export const unlockedStore: LockoutStore = {
  async lockSecondsRemaining() {
    return 0;
  },
  async recordFailure() {},
  async clearFailures() {},
};

export async function runRequest(
  request: Request,
  env: Record<string, string | undefined>,
  deps: Pick<Deps, 'store' | 'verify'> & { log?: (f: LogFields) => void } = {},
): Promise<RunResult> {
  const locals: Record<string, unknown> = {};
  const logs: LogFields[] = [];
  const response = await handleRequest(request, locals, routeNext(request, locals), {
    env,
    store: deps.store ?? unlockedStore,
    verify: deps.verify,
    log: (f) => {
      deps.log?.(f);
      logs.push(f);
    },
  });
  return { response, locals, logs };
}

const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; script-src 'none'",
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
};

export function assertSecurityHeaders(res: Response) {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    assert.equal(res.headers.get(name), value, `header ${name}`);
  }
}

export const TEST_PASSWORD = 'test-password-9f2c';
export const TEST_SECRET = 'test_path-secret_0123456789abcdef0123456789';
export const TEST_ORIGIN = 'http://localhost:56905';

// Generated at runtime; never committed or printed.
export const TEST_HASH = await argon2.hash(TEST_PASSWORD, {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ADMIN_PATH_SECRET: TEST_SECRET,
    ADMIN_USER: 'boss',
    ADMIN_PASSWORD_HASH: TEST_HASH,
    ADMIN_DATABASE_URL: 'postgres://meshgrounds_admin@127.0.0.1:54322/postgres',
    ADMIN_ORIGIN: TEST_ORIGIN,
    ...overrides,
  };
}

export function basicAuth(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}
