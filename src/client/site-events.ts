// LG-1b: fire-and-forget client sender for POST /api/events (page_view, game_launch, error).
// Never blocks or breaks the page: sendBeacon first, fetch keepalive as fallback, every failure dropped.
// Everything sent is scrubbed client-side (no emails, IPs or query strings) so the server's PII check passes.

export type SiteEventType = 'page_view' | 'game_launch' | 'error';
export const MAX_PATH = 512;
export const MAX_MESSAGE = 300;
export const MAX_STACK = 1500;
const ENDPOINT = '/api/events';

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
// `?query` and `#fragment` on anything URL-ish (tokens, codes, emails ride there).
const QUERY = /[?#][^\s)"'<>]*/g;

/** Strips emails, IPs and query strings/fragments, then truncates. Pure; safe on any input. */
export function scrub(text: unknown, max: number): string {
  const s = String(text ?? '')
    .replace(QUERY, '')
    .replace(EMAIL, '[email]')
    .replace(IPV4, '[ip]')
    .replace(IPV6, '[ip]');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Pathname only (never the query string), scrubbed and capped at the server's 512. */
export const scrubPath = (pathname: string) => scrub(pathname, MAX_PATH);

/** Body for an error event: short message and stack, scrubbed and truncated. */
export function errorDetails(source: string, message: unknown, stack?: unknown): Record<string, string> {
  const d: Record<string, string> = { source, message: scrub(message, MAX_MESSAGE) || 'unknown error' };
  const st = scrub(stack, MAX_STACK);
  if (st) d.stack = st;
  return d;
}

/** Sends one event in the background. Returns nothing and never throws. */
export function sendSiteEvent(type: SiteEventType, opts: { path?: string; gameId?: string; details?: Record<string, unknown> } = {}): void {
  try {
    const body = JSON.stringify({
      type,
      path: scrubPath(opts.path ?? location.pathname),
      ...(opts.gameId ? { gameId: opts.gameId } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    });
    let queued = false;
    try {
      // text/plain keeps the beacon CORS-safelisted; the endpoint reads request.text().
      queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      queued = false;
    }
    if (!queued) fetch(ENDPOINT, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {
    /* logging must never break the page */
  }
}

const MAX_ERRORS_PER_PAGE = 5;
let installed = false;

/** Portal pages: one page_view, plus window error / unhandledrejection hooks (capped per page). */
export function installPortalEvents(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  sendSiteEvent('page_view');
  let sent = 0;
  const report = (message: unknown, stack: unknown) => {
    if (sent >= MAX_ERRORS_PER_PAGE) return;
    sent++;
    sendSiteEvent('error', { details: errorDetails('portal', message, stack) });
  };
  window.addEventListener('error', (e) => {
    if (!(e instanceof ErrorEvent)) return; // resource load errors are not script errors
    report(e.message, (e.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: unknown; stack?: unknown } | undefined;
    report(r && typeof r === 'object' ? r.message : r, r && typeof r === 'object' ? r.stack : undefined);
  });
}
