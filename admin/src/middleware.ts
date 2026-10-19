// Request pipeline, in lock order (LLD §3):
//   lock 1 secret path → lock 2 basic auth → lock 3 Supabase session
//   → Origin + CSRF on non-GET.
// Set-Cookie is applied, then the §3.5 header set, on every response
// including lock failures.

import type { MiddlewareHandler } from 'astro';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, type AdminConfig } from './lib/config';
import { gateBasicAuth, type LockoutStore, type PasswordVerifier } from './lib/auth-basic';
import { createRequestAuth, type RequestAuth } from './lib/auth-supabase';
import { connect, createLockoutStore } from './lib/db';
import { CSRF_COOKIE, CSRF_COOKIE_OPTS, CSRF_FIELD, csrfField, mintCookieValue, verifyField } from './lib/csrf';
import { log, type LogFields } from './lib/log';

export type Locals = { csrfCookie?: string; csrfField?: string; auth?: RequestAuth };
export type Deps = {
  env?: Record<string, string | undefined>;
  log?: (fields: LogFields) => void;
  /** Lockout store; default is the postgres.js store on ADMIN_DATABASE_URL. */
  store?: LockoutStore;
  /** Password verifier; default is argon2id/bcrypt per the stored hash. */
  verify?: PasswordVerifier;
  /** Lock 3 session check; default talks to ADMIN_SUPABASE_URL. */
  auth?: (request: Request, config: AdminConfig) => RequestAuth;
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; script-src 'none'",
  'x-robots-tag': 'noindex, nofollow',
  // same-origin, not no-referrer. Chrome sends Origin: null on a form POST
  // under no-referrer, and the CSRF check rejects that opaque origin.
  // same-origin still omits the referrer on every other site.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
};

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

const notFound = () => plain(404, 'Not found');

function segmentMatchesSecret(segment: string, secret: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(segment).digest(),
    createHash('sha256').update(secret).digest(),
  );
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

async function csrfOk(request: Request, config: AdminConfig): Promise<boolean> {
  if (request.headers.get('origin') !== config.origin) return false;
  const cookie = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
  if (!cookie) return false;
  let field: unknown;
  try {
    field = (await request.clone().formData()).get(CSRF_FIELD);
  } catch {
    return false;
  }
  return typeof field === 'string' && verifyField(config.pathSecret, cookie, field);
}

// One lazily-created postgres.js client per function instance (LLD §8.2),
// cached on the validated URL. Tests inject their own store via deps.
let defaultStore: { url: string; store: LockoutStore } | undefined;
function lockoutStore(databaseUrl: string): LockoutStore {
  if (defaultStore?.url !== databaseUrl) {
    defaultStore = { url: databaseUrl, store: createLockoutStore(connect(databaseUrl)) };
  }
  return defaultStore.store;
}

// Exact paths only. These still pass locks 1 and 2. The stylesheet is not
// an auth route. Auth routes render their own pages and do not run lock 3.
const LOCK3_EXEMPT = new Set([
  '/admin.css',
  '/auth/signin',
  '/auth/mfa',
  '/auth/mfa/enroll',
  '/auth/signout',
]);

function lock3Exempt(pathname: string, segment: string): boolean {
  const prefix = `/${segment}`;
  if (!pathname.startsWith(`${prefix}/`)) return false;
  return LOCK3_EXEMPT.has(pathname.slice(prefix.length));
}

function isAuthRoute(pathname: string, segment: string): boolean {
  if (!lock3Exempt(pathname, segment)) return false;
  return pathname.slice(`/${segment}`.length).startsWith('/auth/');
}

function defaultAuth(request: Request, config: AdminConfig): RequestAuth {
  return createRequestAuth({
    url: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    adminUserId: config.adminUserId,
    request,
  });
}

type Lock3Result = { ok: true; setCookies: string[] } | { ok: false; response: Response; setCookies: string[] };

async function lock3(
  request: Request,
  config: AdminConfig,
  deps: Deps,
  fields: LogFields,
): Promise<Lock3Result> {
  let session: RequestAuth | undefined;
  try {
    session = (deps.auth ?? defaultAuth)(request, config);
    const kind = await session.classify();
    switch (kind.kind) {
      case 'ok':
        return { ok: true, setCookies: session.setCookies() };
      case 'other-user': {
        try {
          await session.signOut();
        } catch {
          fields.level = 'error';
          fields.error = 'auth_error';
        }
        fields.lock = 3;
        return { ok: false, response: notFound(), setCookies: session.setCookies() };
      }
      case 'aal1-ben':
      case 'none':
      case 'error': {
        if (kind.kind === 'error') {
          fields.level = 'error';
          fields.error = 'auth_error';
        }
        fields.lock = 3;
        return { ok: false, response: notFound(), setCookies: session.setCookies() };
      }
      default: {
        const unreachable: never = kind;
        throw unreachable;
      }
    }
  } catch {
    fields.lock = 3;
    fields.level = 'error';
    fields.error = 'auth_error';
    return { ok: false, response: notFound(), setCookies: session?.setCookies() ?? [] };
  }
}

async function route(
  request: Request,
  locals: Locals,
  next: () => Promise<Response>,
  env: Record<string, string | undefined>,
  deps: Deps,
  fields: LogFields,
): Promise<{ response: Response; setCsrfCookie?: string; setCookies?: string[] }> {
  const cfg = loadConfig(env);
  if (!cfg.ok) {
    fields.level = 'error';
    fields.error = `invalid_config:${cfg.key}`;
    return { response: plain(503, 'Service unavailable') };
  }
  const config = cfg.config;
  const method = request.method;
  const pathname = new URL(request.url).pathname;

  // Lock 1: first path segment must equal ADMIN_PATH_SECRET; only GET /robots.txt
  // escapes it. Everything else — and every method other than GET/POST — is the
  // same plain 404: no WWW-Authenticate, no cookies, no markup.
  if (method !== 'GET' && method !== 'POST') {
    fields.lock = 1;
    return { response: notFound() };
  }
  if (method === 'GET' && pathname === '/robots.txt') {
    return { response: await next() };
  }
  const segment = pathname.split('/')[1] ?? '';
  if (!segmentMatchesSecret(segment, config.pathSecret)) {
    fields.lock = 1;
    return { response: notFound() };
  }

  // Lock 2: basic auth behind the DB-backed lockout (LLD §3.2, §8.3). The
  // store is queried before any credential work: while locked nothing is
  // verified and no row is written, so the lock cannot extend itself.
  const auth = await gateBasicAuth(
    request.headers.get('authorization'),
    config,
    deps.store ?? lockoutStore(config.databaseUrl),
    deps.verify,
  );
  if (auth.kind === 'locked') {
    fields.lock = 2;
    return {
      response: plain(429, 'Too many requests', {
        'retry-after': String(auth.retryAfterSeconds),
      }),
    };
  }
  if (auth.kind === 'unavailable') {
    fields.level = 'error';
    fields.error = auth.code;
    return { response: plain(503, 'Service unavailable') };
  }
  if (auth.kind === 'fail') {
    fields.lock = 2;
    return {
      response: plain(401, 'Unauthorized', {
        'www-authenticate': 'Basic realm="admin", charset="UTF-8"',
      }),
    };
  }

  // Lock 3: the session must be ADMIN_USER_ID at AAL2 with a verified TOTP
  // factor. Anything else is the same plain 404 as lock 1. Auth routes and
  // the stylesheet are exempt. Auth routes still get a client so the page
  // can sign in, enroll, verify, or sign out, and its Set-Cookie values
  // ride on the response.
  let authCookies: string[] | undefined;
  let session: RequestAuth | undefined;
  if (isAuthRoute(pathname, segment)) {
    session = (deps.auth ?? defaultAuth)(request, config);
    locals.auth = session;
  }
  if (!lock3Exempt(pathname, segment)) {
    const gate = await lock3(request, config, deps, fields);
    if (!gate.ok) return { response: gate.response, setCookies: gate.setCookies };
    authCookies = gate.setCookies;
  }
  const cookies = () => session?.setCookies() ?? authCookies;

  if (method === 'POST') {
    if (!(await csrfOk(request, config))) {
      fields.error = 'csrf';
      return { response: plain(403, 'Forbidden'), setCookies: cookies() };
    }
    const csrfCookie = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
    if (csrfCookie) {
      locals.csrfCookie = csrfCookie;
      locals.csrfField = csrfField(config.pathSecret, csrfCookie);
    }
    return { response: await next(), setCookies: cookies() };
  }

  // GET past locks 1-2: ensure the CSRF cookie exists so pages can embed the
  // field and later POSTs can verify.
  const existing = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
  locals.csrfCookie = existing ?? mintCookieValue();
  locals.csrfField = csrfField(config.pathSecret, locals.csrfCookie);
  return {
    response: await next(),
    setCsrfCookie: existing ? undefined : locals.csrfCookie,
    setCookies: cookies(),
  };
}

export async function handleRequest(
  request: Request,
  locals: Locals,
  next: () => Promise<Response>,
  deps: Deps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const emit = deps.log ?? ((fields: LogFields) => log(fields));
  const start = performance.now();
  const fields: LogFields = {};
  let response: Response;
  let setCsrfCookie: string | undefined;
  let setCookies: string[] | undefined;
  try {
    ({ response, setCsrfCookie, setCookies } = await route(request, locals, next, env, deps, fields));
  } catch {
    // Never let a route error surface as an Astro/framework error page.
    fields.level = 'error';
    fields.error = 'unhandled';
    response = plain(500, 'Internal server error');
  }
  for (const cookie of setCookies ?? []) response.headers.append('set-cookie', cookie);
  // A 404 is the lock-1 response: it does not mint a CSRF cookie.
  if (setCsrfCookie && response.status !== 404) {
    response.headers.append('set-cookie', `${CSRF_COOKIE}=${setCsrfCookie}; ${CSRF_COOKIE_OPTS}`);
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  fields.status = response.status;
  fields.duration_ms = Math.round((performance.now() - start) * 100) / 100;
  emit(fields);
  return response;
}

export const onRequest: MiddlewareHandler = (context, next) =>
  handleRequest(context.request, context.locals, () => next());
