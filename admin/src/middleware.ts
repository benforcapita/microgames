// Request pipeline, in lock order (LLD §3):
//   lock 1 secret path → lock 2 basic auth → [lock 3 slot, MGA-2b]
//   → security headers → CSRF on POST.
// Every response, including lock failures, carries the §3.5 header set.

import type { MiddlewareHandler } from 'astro';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, type AdminConfig } from './lib/config';
import { checkBasicAuth } from './lib/auth-basic';
import { CSRF_COOKIE, CSRF_COOKIE_OPTS, CSRF_FIELD, csrfField, mintCookieValue, verifyField } from './lib/csrf';
import { log, type LogFields } from './lib/log';

export type Locals = { csrfCookie?: string; csrfField?: string };
export type Deps = {
  env?: Record<string, string | undefined>;
  log?: (fields: LogFields) => void;
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; script-src 'none'",
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
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

async function route(
  request: Request,
  locals: Locals,
  next: () => Promise<Response>,
  env: Record<string, string | undefined>,
  fields: LogFields,
): Promise<{ response: Response; setCsrfCookie?: string }> {
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

  // Lock 2: basic auth. The password verify always runs so timing reveals nothing.
  // Lockout hook (MGA-2 PR B): BEFORE checking credentials, count
  // admin_auth_failures rows newer than 15 min; at 5+ return a plain 429 with
  // Retry-After = remaining lock seconds (rounded up, cap 900) WITHOUT running
  // the password verify and WITHOUT inserting a failure row. Each failed check
  // below inserts one row; a success deletes all rows.
  if (!(await checkBasicAuth(request.headers.get('authorization'), config))) {
    fields.lock = 2;
    return {
      response: plain(401, 'Unauthorized', {
        'www-authenticate': 'Basic realm="admin", charset="UTF-8"',
      }),
    };
  }

  // lock 3 slot (MGA-2b): Supabase session + AAL2 check goes here.

  if (method === 'POST') {
    if (!(await csrfOk(request, config))) {
      fields.error = 'csrf';
      return { response: plain(403, 'Forbidden') };
    }
    return { response: await next() };
  }

  // GET past locks 1-2: ensure the CSRF cookie exists so pages can embed the
  // field and later POSTs can verify.
  const existing = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
  locals.csrfCookie = existing ?? mintCookieValue();
  locals.csrfField = csrfField(config.pathSecret, locals.csrfCookie);
  return { response: await next(), setCsrfCookie: existing ? undefined : locals.csrfCookie };
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
  try {
    ({ response, setCsrfCookie } = await route(request, locals, next, env, fields));
  } catch {
    // Never let a route error surface as an Astro/framework error page.
    fields.level = 'error';
    fields.error = 'unhandled';
    response = plain(500, 'Internal server error');
  }
  if (setCsrfCookie) {
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
