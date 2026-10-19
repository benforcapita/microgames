// Builds the cookie shape @supabase/ssr reads, and a fetch that stands in for
// Auth. Tokens here are unsigned fixtures, minted in the test process.

export const MOCK_AUTH_URL = 'https://admin-supabase-test.example';
export const MOCK_COOKIE_NAME = 'sb-admin-supabase-test-auth-token';

export function jwtWithClaim(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('sig').toString('base64url');
  return `${header}.${body}.${sig}`;
}

export function sessionCookieValue(accessToken: string, expiresAt: number, refreshToken = 'refresh-token'): string {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'fixture-user' },
  };
  return `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
}

export function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 60 * 60;
}

export function pastExp(): number {
  return Math.floor(Date.now() / 1000) - 60;
}

export type FactorFixture = {
  id: string;
  factor_type: 'totp' | 'phone';
  status: 'verified' | 'unverified';
};

export type AuthScript = {
  userId: string;
  factors?: FactorFixture[];
  /** /user returns 200 only for this bearer. */
  acceptedBearer?: string;
  userStatus?: number;
  refresh?: { accessToken: string; refreshToken?: string };
  throwNetwork?: boolean;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bearerOf(init: RequestInit | undefined): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
}

export function scriptedFetch(script: AuthScript): typeof fetch {
  return async (input, init) => {
    if (script.throwNetwork) throw new Error('network');
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.pathname.endsWith('/auth/v1/user')) {
      if (script.userStatus && script.userStatus !== 200) {
        return json({ error: 'invalid', message: 'rejected' }, script.userStatus);
      }
      const bearer = bearerOf(init);
      if (script.acceptedBearer && bearer !== script.acceptedBearer) {
        return json({ error: 'invalid', message: 'rejected' }, 401);
      }
      return json(
        { id: script.userId, aud: 'authenticated', factors: script.factors ?? [] },
        200,
      );
    }
    if (url.pathname.endsWith('/token')) {
      if (!script.refresh) return json({ error: 'refresh_failed', message: 'rejected' }, 400);
      return json(
        {
          access_token: script.refresh.accessToken,
          refresh_token: script.refresh.refreshToken ?? 'rotated-refresh',
          expires_in: 3600,
          expires_at: futureExp(),
          token_type: 'bearer',
          user: { id: script.userId, factors: script.factors ?? [] },
        },
        200,
      );
    }
    return json({}, 200);
  };
}

export function cookieHeader(value: string, name = MOCK_COOKIE_NAME): string {
  return `${name}=${value}`;
}
