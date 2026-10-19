// Lock 3 session check. Supabase Auth is outside this process: every error,
// timeout, or unexpected payload is a denial.
//
// AAL is taken only from the access token that getUser() just had the Auth
// server accept. getUser() with no jwt is what refreshes an expired session
// inside this request; the guarded fetch records the Bearer token on the
// successful GET /auth/v1/user. getAuthenticatorAssuranceLevel(token) then
// decodes `aal` from that same string and validates it again. A cookie is
// never decoded for the decision. If that token was not captured, the result
// is `error`.
//
// A verified TOTP factor is read from the user object on that getUser()
// response. cookieOptions asks @supabase/ssr for the strict attributes, and
// setAll forces them again so a library default cannot ship.

import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

export type AuthKind =
  | { kind: 'ok' }
  | { kind: 'aal1-ben'; verifiedTotp: boolean }
  | { kind: 'other-user' }
  | { kind: 'none' }
  | { kind: 'error' };

export type RequestAuth = {
  classify(): Promise<AuthKind>;
  signOut(): Promise<void>;
  setCookies(): string[];
};

export type CreateRequestAuthOptions = {
  url: string;
  anonKey: string;
  adminUserId: string;
  request: Request;
  /** Override the Auth fetch. Production uses global fetch. */
  fetch?: typeof fetch;
  /** Per-request deadline for each Auth HTTP call. Default 5s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;

export function serializeStrictCookie(
  name: string,
  value: string,
  options?: { maxAge?: number; expires?: Date },
): string {
  if (!/^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name)) {
    throw new Error('invalid_cookie_name');
  }
  const unsafe = /[\r\n;]/.test(value);
  const safeValue = unsafe ? '' : value;
  const maxAge = unsafe ? 0 : options?.maxAge;
  const expires = unsafe ? undefined : options?.expires;
  const parts = [`${name}=${safeValue}`, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'];
  if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
    parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  }
  if (expires instanceof Date && !Number.isNaN(expires.getTime())) {
    parts.push(`Expires=${expires.toUTCString()}`);
  }
  return parts.join('; ');
}

function errorName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isUserEndpoint(input: RequestInfo | URL): boolean {
  try {
    return new URL(requestUrl(input)).pathname.endsWith('/auth/v1/user');
  } catch {
    return false;
  }
}

function authorizationBearer(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  let raw: string | null = null;
  if (headers instanceof Headers) {
    raw = headers.get('authorization');
  } else if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === 'authorization');
    raw = found?.[1] ?? null;
  } else {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
    raw = key ? headers[key] : null;
  }
  return raw?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
}

function hasVerifiedTotp(user: User): boolean {
  return (user.factors ?? []).some((factor) => factor.factor_type === 'totp' && factor.status === 'verified');
}

function decide(level: string | null, verifiedTotp: boolean): AuthKind {
  switch (level) {
    case 'aal1':
      return { kind: 'aal1-ben', verifiedTotp };
    case 'aal2':
      return verifiedTotp ? { kind: 'ok' } : { kind: 'error' };
    case null:
      return { kind: 'error' };
    default:
      return { kind: 'error' };
  }
}

export function createRequestAuth(options: CreateRequestAuthOptions): RequestAuth {
  const collected: string[] = [];
  let validatedToken: string | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseFetch = options.fetch ?? fetch;

  const guardedFetch: typeof fetch = async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const nextInit: RequestInit = { ...init, signal };
    const response = await baseFetch(input, nextInit);
    if (response.ok && isUserEndpoint(input)) {
      const bearer = authorizationBearer(nextInit.headers);
      if (bearer) validatedToken = bearer;
    }
    return response;
  };

  const readCookies = () =>
    parseCookieHeader(options.request.headers.get('cookie') ?? '').map((cookie) => ({
      name: cookie.name,
      value: cookie.value ?? '',
    }));

  const client = createServerClient(options.url, options.anonKey, {
    cookieOptions: {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    },
    global: { fetch: guardedFetch },
    cookies: {
      getAll: readCookies,
      setAll(cookies) {
        for (const cookie of cookies) {
          collected.push(serializeStrictCookie(cookie.name, cookie.value, cookie.options));
        }
      },
    },
  });

  return {
    async classify(): Promise<AuthKind> {
      try {
        const { data, error } = await client.auth.getUser();
        if (error) {
          return errorName(error) === 'AuthSessionMissingError' ? { kind: 'none' } : { kind: 'error' };
        }
        const user = data.user;
        if (!user?.id) return { kind: 'none' };
        if (user.id !== options.adminUserId) return { kind: 'other-user' };
        const token = validatedToken;
        if (!token) return { kind: 'error' };
        const { data: assurance, error: assuranceError } =
          await client.auth.mfa.getAuthenticatorAssuranceLevel(token);
        if (assuranceError || !assurance) return { kind: 'error' };
        return decide(assurance.currentLevel, hasVerifiedTotp(user));
      } catch {
        return { kind: 'error' };
      }
    },
    async signOut(): Promise<void> {
      try {
        await client.auth.signOut();
      } catch {
        // Still clear the browser cookies below.
      }
      for (const cookie of readCookies()) {
        if (!cookie.name.startsWith('sb-')) continue;
        try {
          collected.push(serializeStrictCookie(cookie.name, '', { maxAge: 0 }));
        } catch {
          // An unusable name cannot be cleared safely. Skip it.
        }
      }
    },
    setCookies(): string[] {
      return collected;
    },
  };
}
