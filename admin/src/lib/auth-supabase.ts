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
import type { Factor, User } from '@supabase/supabase-js';

export type AuthKind =
  | { kind: 'ok' }
  | { kind: 'aal1-ben'; verifiedTotp: boolean }
  | { kind: 'other-user' }
  | { kind: 'none' }
  | { kind: 'error' };

export type SignOutScope = 'local' | 'global';

export type PasswordSignInResult =
  | { kind: 'ben'; verifiedTotp: boolean }
  | { kind: 'other-user' }
  | { kind: 'denied' };

export type ReportedFactor = {
  id: string;
  factorType: 'totp' | 'phone' | 'webauthn' | 'recovery_code';
};

export type FactorListResult = { kind: 'ok'; unverified: ReportedFactor[] } | { kind: 'denied' };

export type EnrollResult =
  | {
      kind: 'ok';
      factorId: string;
      qrDataUri: string;
      secret: string;
      unverified: ReportedFactor[];
    }
  | { kind: 'denied'; unverified: ReportedFactor[] };

export type VerifyResult = { kind: 'ok' } | { kind: 'denied' } | { kind: 'no-factor' };

export type RequestAuth = {
  classify(): Promise<AuthKind>;
  /** Default scope is global, matching lock 3's other-user sign-out. */
  signOut(scope?: SignOutScope): Promise<void>;
  setCookies(): string[];
  signInWithPassword(email: string, password: string): Promise<PasswordSignInResult>;
  unverifiedFactors(): Promise<FactorListResult>;
  enrollTotp(): Promise<EnrollResult>;
  verifyTotp(factorId: string, code: string): Promise<VerifyResult>;
  verifyVerifiedTotp(code: string): Promise<VerifyResult>;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SVG_DATA_PREFIX = 'data:image/svg+xml;utf-8,';

function hasVerifiedTotp(user: User): boolean {
  return (user.factors ?? []).some((factor) => factor.factor_type === 'totp' && factor.status === 'verified');
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isTotpSecret(value: string): boolean {
  return /^[A-Z2-7]{16,128}$/.test(value);
}

function isTotpCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}

function reportedType(value: Factor['factor_type']): ReportedFactor['factorType'] {
  switch (value) {
    case 'totp':
    case 'phone':
    case 'webauthn':
    case 'recovery_code':
      return value;
    default: {
      const unreachable: never = value;
      throw unreachable;
    }
  }
}

function unverifiedFrom(factors: Factor[]): ReportedFactor[] {
  const out: ReportedFactor[] = [];
  for (const factor of factors) {
    if (factor.status !== 'unverified' || !isUuid(factor.id)) continue;
    out.push({ id: factor.id, factorType: reportedType(factor.factor_type) });
  }
  return out;
}

// Auth returns an SVG, sometimes with an XML declaration. The client prefixes
// `data:image/svg+xml;utf-8,`. Percent-encoding keeps `#` and quotes inside a
// data URI the browser can paint from an img src. Anything else is refused.
const MAX_QR_CHARS = 1_000_000;

function qrDataUri(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_QR_CHARS) return undefined;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) return raw;
  let svg: string | undefined;
  if (raw.startsWith(SVG_DATA_PREFIX)) svg = raw.slice(SVG_DATA_PREFIX.length);
  else if (raw.startsWith('<svg') || raw.startsWith('<?xml')) svg = raw;
  if (!svg || svg.length > MAX_QR_CHARS || !svg.includes('<svg') || !svg.includes('</svg>')) return undefined;
  if (/<script|javascript:|\son[a-z]+=/i.test(svg)) return undefined;
  return SVG_DATA_PREFIX + encodeURIComponent(svg);
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
  const written = new Set<string>();
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
          written.add(cookie.name);
          collected.push(serializeStrictCookie(cookie.name, cookie.value, cookie.options));
        }
      },
    },
  });

  function clearSbCookies(): void {
    const names = new Set<string>();
    for (const cookie of readCookies()) {
      if (cookie.name.startsWith('sb-')) names.add(cookie.name);
    }
    for (const name of written) {
      if (name.startsWith('sb-')) names.add(name);
    }
    for (const name of names) {
      try {
        collected.push(serializeStrictCookie(name, '', { maxAge: 0 }));
      } catch {
        // An unusable name cannot be cleared safely. Skip it.
      }
    }
  }

  async function loadFactors(): Promise<Factor[] | undefined> {
    const listed = await client.auth.mfa.listFactors();
    if (listed.error || !listed.data) return undefined;
    return listed.data.all;
  }

  async function verifyFactor(factorId: string, code: string): Promise<VerifyResult> {
    if (!isUuid(factorId) || !isTotpCode(code)) return { kind: 'denied' };
    const verified = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (verified.error || !verified.data?.access_token) return { kind: 'denied' };
    return { kind: 'ok' };
  }

  async function endSession(scope: SignOutScope): Promise<void> {
    try {
      if (scope === 'local') await client.auth.signOut({ scope: 'local' });
      else await client.auth.signOut();
    } catch {
      // Still clear the browser cookies below.
    }
    clearSbCookies();
  }

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
    signOut(scope: SignOutScope = 'global'): Promise<void> {
      return endSession(scope);
    },
    setCookies(): string[] {
      return collected;
    },
    async signInWithPassword(email: string, password: string): Promise<PasswordSignInResult> {
      if (!email || !password || email.length > 320 || password.length > 1024) return { kind: 'denied' };
      try {
        const signedIn = await client.auth.signInWithPassword({ email, password });
        if (signedIn.error || !signedIn.data.user?.id) return { kind: 'denied' };
        if (signedIn.data.user.id !== options.adminUserId) return { kind: 'other-user' };
        const factors = await loadFactors();
        if (!factors) {
          await endSession('local');
          return { kind: 'denied' };
        }
        const verifiedTotp = factors.some(
          (factor) => factor.factor_type === 'totp' && factor.status === 'verified',
        );
        return { kind: 'ben', verifiedTotp };
      } catch {
        return { kind: 'denied' };
      }
    },
    async unverifiedFactors(): Promise<FactorListResult> {
      try {
        const factors = await loadFactors();
        if (!factors) return { kind: 'denied' };
        return { kind: 'ok', unverified: unverifiedFrom(factors) };
      } catch {
        return { kind: 'denied' };
      }
    },
    async enrollTotp(): Promise<EnrollResult> {
      let unverified: ReportedFactor[] = [];
      try {
        const factors = await loadFactors();
        if (!factors) return { kind: 'denied', unverified };
        unverified = unverifiedFrom(factors);
        const enrolled = await client.auth.mfa.enroll({ factorType: 'totp' });
        if (enrolled.error || enrolled.data?.type !== 'totp') return { kind: 'denied', unverified };
        const qr = qrDataUri(enrolled.data.totp.qr_code);
        const secret = enrolled.data.totp.secret;
        if (!qr || !isTotpSecret(secret) || !isUuid(enrolled.data.id)) return { kind: 'denied', unverified };
        return { kind: 'ok', factorId: enrolled.data.id, qrDataUri: qr, secret, unverified };
      } catch {
        return { kind: 'denied', unverified };
      }
    },
    async verifyTotp(factorId: string, code: string): Promise<VerifyResult> {
      try {
        return await verifyFactor(factorId, code);
      } catch {
        return { kind: 'denied' };
      }
    },
    async verifyVerifiedTotp(code: string): Promise<VerifyResult> {
      try {
        if (!isTotpCode(code)) return { kind: 'denied' };
        const factors = await loadFactors();
        if (!factors) return { kind: 'denied' };
        const factor = factors.find((item) => item.factor_type === 'totp' && item.status === 'verified');
        if (!factor) return { kind: 'no-factor' };
        return await verifyFactor(factor.id, code);
      } catch {
        return { kind: 'denied' };
      }
    },
  };
}
