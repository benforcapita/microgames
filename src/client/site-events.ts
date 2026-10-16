// LG-1b: fire-and-forget client sender for POST /api/events (page_view, game_launch, error).
// Never blocks or breaks the page: sendBeacon first, fetch keepalive as fallback, every failure dropped.
// Everything sent is cleaned with the SAME detector the server enforces (../lib/pii): query strings and
// fragments stripped, PII redacted, text cut by UTF-8 bytes on code-point boundaries under the server caps.
import { redactPii, redactUrlIntIpv4, truncateText, utf8Bytes } from '../lib/pii';

export type SiteEventType = 'page_view' | 'game_launch' | 'error';
/** Server: path <= 512 UTF-16 units; details JSON <= 4000 UTF-8 bytes. */
export const MAX_PATH_UNITS = 512;
export const MAX_PATH_BYTES = 1024;
export const MAX_MESSAGE_BYTES = 600;
export const MAX_STACK_BYTES = 2400;
export const MAX_DETAILS_BYTES = 3800;
export const MAX_ERRORS_PER_PAGE = 5;
const ENDPOINT = '/api/events';

// `?query` and `#fragment` on anything URL-ish (tokens, codes, emails ride there).
const QUERY = /[?#][^\s)"'<>]*/g;

/** Strips query strings/fragments, redacts PII, then truncates to maxBytes (code-point safe). Pure; safe on any input. */
export function scrub(text: unknown, maxBytes: number, maxUnits = Infinity): string {
  return truncateText(redactPii(String(text ?? '').replace(QUERY, '')), maxBytes, maxUnits);
}

/** Pathname only (never the query string or hash), scrubbed and capped at the server's 512 units. */
// A whole path segment that is a decimal-integer IPv4 is redacted, matching the server's URL-only rule.
export const scrubPath = (pathname: string) => scrub(redactUrlIntIpv4(pathname.replace(QUERY, '')), MAX_PATH_BYTES, MAX_PATH_UNITS);

/** Body for an error event: short message and stack, scrubbed, and guaranteed under the server's details cap. */
export function errorDetails(source: string, message: unknown, stack?: unknown): Record<string, string> {
  const d: Record<string, string> = { source: scrub(source, 40), message: scrub(message, MAX_MESSAGE_BYTES) || 'unknown error' };
  let st = scrub(stack, MAX_STACK_BYTES);
  if (st) d.stack = st;
  // JSON escaping (\n, \", control chars) can grow the payload; shrink the stack until it fits.
  while (d.stack && utf8Bytes(JSON.stringify(d)) > MAX_DETAILS_BYTES) {
    st = truncateText(d.stack, Math.floor(utf8Bytes(d.stack) / 2));
    if (st.length <= 1) delete d.stack;
    else d.stack = st;
  }
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
      // text/plain keeps the beacon CORS-safelisted; the endpoint reads the raw body.
      queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      queued = false;
    }
    if (!queued) fetch(ENDPOINT, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {
    /* logging must never break the page */
  }
}

let installed = false;

/** Portal pages: a page_view (again on a bfcache restore), plus window error / unhandledrejection hooks, capped per page. */
export function installPortalEvents(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  sendSiteEvent('page_view');
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) sendSiteEvent('page_view');
  });
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
    const r = (e as PromiseRejectionEvent).reason as { message?: unknown; stack?: unknown } | undefined;
    report(r && typeof r === 'object' ? r.message : r, r && typeof r === 'object' ? r.stack : undefined);
  });
}
