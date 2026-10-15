import { safeNext } from './safe-next';

/** Production portal. Confirmation and magic-link redirects are allowed here. */
export const PORTAL_ORIGIN = 'https://meshground.com';
/** Other production hosts that serve the same portal: www, and the Vercel project's default domain. */
export const PORTAL_ALIASES = new Set([PORTAL_ORIGIN, 'https://www.meshground.com', 'https://meshgrounds.vercel.app']);

/**
 * Vercel preview hosts for the portal project (team benteam2).
 * The game CDN project (`meshgrounds-cdn-…`) does not serve `/auth/callback`.
 */
export const PREVIEW_ORIGIN_RE = /^https:\/\/meshgrounds-(?!cdn-)[a-z0-9-]+-benteam2\.vercel\.app$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isAllowedEmailOrigin(origin: string, allowLocal: boolean): boolean {
  if (typeof origin !== 'string' || !origin || /[\s\u0000-\u001f\u007f]/.test(origin)) return false;
  if (PORTAL_ALIASES.has(origin)) return true;
  if (PREVIEW_ORIGIN_RE.test(origin)) return true;
  if (!allowLocal) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  return LOCAL_HOSTS.has(url.hostname);
}

export interface EmailRedirectInput {
  requestUrl: URL;
  next: string;
  /** Browser Origin header. Used only when the request URL's origin is not allowlisted. */
  originHeader?: string | null;
  /** Localhost is allowed only when this is not `production`. Defaults to `NODE_ENV`. */
  nodeEnv?: string;
}

/**
 * Absolute callback for Supabase `emailRedirectTo` (sign-up, magic link, and any
 * reset-password flow). Built from the request origin, then the Origin header.
 * Never from `SITE_URL` or the shared project's Auth Site URL. Returns null when
 * no allowlisted origin matches, so the caller does not send mail that would
 * fall back to that Site URL.
 */
export function authEmailRedirect(input: EmailRedirectInput): string | null {
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
  const allowLocal = nodeEnv !== 'production';
  const header = typeof input.originHeader === 'string' ? input.originHeader : '';
  let origin: string | null = null;
  for (const candidate of [input.requestUrl.origin, header]) {
    if (candidate && isAllowedEmailOrigin(candidate, allowLocal)) {
      origin = candidate;
      break;
    }
  }
  if (!origin) return null;
  return `${origin}/auth/callback?next=${encodeURIComponent(safeNext(input.next))}`;
}
