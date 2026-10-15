// Who may call validate-game. The function runs with verify_jwt = false (see supabase/config.toml)
// because the EF-2 database hook authenticates with a shared secret header instead of a JWT.
//
// A request is authorised if EITHER:
//  (a) header `x-meshgrounds-hook` equals env VALIDATE_GAME_HOOK_SECRET (constant-time compare).
//      If VALIDATE_GAME_HOOK_SECRET is unset/empty this path is always rejected.
//  (b) `Authorization: Bearer <service-role JWT>` for manual reruns: either byte-equal to
//      SUPABASE_SERVICE_ROLE_KEY, or an HS256 JWT signed with SUPABASE_JWT_SECRET whose role is
//      service_role and which hasn't expired.
// Anything else gets 401. Secrets are never logged or echoed.

export interface AuthEnv {
  hookSecret?: string;
  serviceRoleKey?: string;
  jwtSecret?: string;
}

const enc = new TextEncoder();

/** Constant-time comparison (length is not secret; content is). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function verifyServiceJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    if (header.alg !== 'HS256') return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
    return payload.role === 'service_role' && (typeof payload.exp !== 'number' || payload.exp > nowSec);
  } catch {
    return false;
  }
}

export async function isAuthorized(req: Request, env: AuthEnv): Promise<boolean> {
  const hook = req.headers.get('x-meshgrounds-hook');
  if (hook !== null && env.hookSecret && timingSafeEqual(hook, env.hookSecret)) return true;
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (env.serviceRoleKey && timingSafeEqual(token, env.serviceRoleKey)) return true;
  return env.jwtSecret ? verifyServiceJwt(token, env.jwtSecret) : false;
}

/** Body is { gameId, reason? }; unknown fields are ignored. */
export async function parseBody(req: Request): Promise<{ gameId: string; reason?: string } | { error: string }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { error: 'body must be JSON { gameId, reason? }' };
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.gameId !== 'string' || !b.gameId) return { error: 'gameId required' };
  return { gameId: b.gameId, ...(typeof b.reason === 'string' ? { reason: b.reason.slice(0, 64) } : {}) };
}
