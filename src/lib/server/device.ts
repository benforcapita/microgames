/**
 * IS-3 device detection and catalog filtering.
 *
 * Sec-CH-UA-Mobile is authoritative when the browser sends it. User-Agent is the fallback for
 * clients that never send the hint (non-Chromium, or a first hop before Critical-CH retries).
 * No client-side refinement: the HTML is already filtered, and Critical-CH asks Chromium to
 * resend the navigation with the hint when it was missing.
 *
 * `games.input_support` arrives in IS-1. Until that column exists, reads treat every game as
 * `unknown` (still visible) and a 42703 on the desktop filter is retried without it.
 */

export type DeviceKind = 'mobile' | 'desktop';
export type InputSupport = 'mobile' | 'desktop' | 'both' | 'unknown';
export type PlaySurface = 'player' | 'desktop-only';

const INPUT_SUPPORTS = new Set<InputSupport>(['mobile', 'desktop', 'both', 'unknown']);

/** Low-entropy client hint we vary on. Must be listed in both Accept-CH and Critical-CH. */
export const CLIENT_HINT = 'Sec-CH-UA-Mobile';

const MOBILE_UA = /iPhone|iPod|iPad|Android.+Mobile|Mobile|webOS|BlackBerry|IEMobile|Opera Mini|Silk|Kindle/i;

const warned = { inputSupport: false };

export function resetInputSupportWarning(): void {
  warned.inputSupport = false;
}

export function normalizeInputSupport(value: unknown): InputSupport {
  if (typeof value !== 'string') return 'unknown';
  const v = value.trim().toLowerCase();
  return INPUT_SUPPORTS.has(v as InputSupport) ? (v as InputSupport) : 'unknown';
}

function headerValue(headers: { get(name: string): string | null | undefined }, name: string): string | null {
  const value = headers.get(name);
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** `?1` is mobile, `?0` is desktop. Anything else falls through to the User-Agent. */
export function detectDevice(headers: { get(name: string): string | null | undefined }): DeviceKind {
  const hint = headerValue(headers, 'sec-ch-ua-mobile');
  if (hint === '?1') return 'mobile';
  if (hint === '?0') return 'desktop';
  return uaIsMobile(headerValue(headers, 'user-agent') ?? '') ? 'mobile' : 'desktop';
}

export function uaIsMobile(ua: string): boolean {
  return MOBILE_UA.test(ua);
}

/** Desktop sees every game. Mobile hides `desktop` only; unknown, mobile, and both stay. */
export function visibleOnDevice(inputSupport: unknown, device: DeviceKind): boolean {
  if (device !== 'mobile') return true;
  return normalizeInputSupport(inputSupport) !== 'desktop';
}

export function filterForDevice<T extends { inputSupport: unknown }>(items: T[], device: DeviceKind): T[] {
  if (device !== 'mobile') return items;
  return items.filter((item) => visibleOnDevice(item.inputSupport, device));
}

export function playSurface(device: DeviceKind, inputSupport: unknown): PlaySurface {
  return device === 'mobile' && normalizeInputSupport(inputSupport) === 'desktop' ? 'desktop-only' : 'player';
}

/**
 * The "fork of" credit always names the parent. Mobile visitors get plain text when that
 * parent is desktop-only, because the play link is not a playable page for them.
 * Desktop visitors always get the link.
 */
export function forkParentLinked(device: DeviceKind, inputSupport: unknown): boolean {
  return visibleOnDevice(inputSupport, device);
}

export interface DesktopOnlyNotice {
  heading: 'Desktop only';
  title: string;
  message: string;
}

export function desktopOnlyNotice(title: string): DesktopOnlyNotice {
  const safe = title.trim() || 'This game';
  return {
    heading: 'Desktop only',
    title: safe,
    message: `Open ${safe} on a computer.`,
  };
}

const VARIED_PATHS = [/^\/$/, /^\/games(?:\/|$)/, /^\/proving(?:\/|$)/, /^\/play(?:\/|$)/, /^\/u(?:\/|$)/, /^\/creators(?:\/|$)/];

/** HTML whose game list or player depends on the device. */
export function variesByDevice(pathname: string): boolean {
  return VARIED_PATHS.some((re) => re.test(pathname));
}

/**
 * Stop a shared cache from serving a mobile catalog to a desktop browser (or the reverse).
 * Critical-CH makes Chromium retry the request with Sec-CH-UA-Mobile when the first hop omitted it.
 */
export function applyDeviceHeaders(headers: Headers, pathname: string): void {
  if (!variesByDevice(pathname)) return;
  headers.set('Accept-CH', CLIENT_HINT);
  headers.set('Critical-CH', CLIENT_HINT);
  const needed = ['Sec-CH-UA-Mobile', 'User-Agent'];
  const existing = (headers.get('Vary') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  for (const name of needed) {
    if (!existing.some((part) => part.toLowerCase() === name.toLowerCase())) existing.push(name);
  }
  headers.set('Vary', existing.join(', '));
  headers.set('Cache-Control', 'private, no-store');
}

export function isMissingInputSupportColumn(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42703') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /input_support/i.test(message) && /does not exist/i.test(message);
}

function warnMissingInputSupport(err: unknown): void {
  if (warned.inputSupport) return;
  warned.inputSupport = true;
  const code = (err as { code?: string } | null)?.code ?? '42703';
  console.warn(`[meshgrounds] games.input_support is not available yet (${code}); treating every game as unknown`);
}

/** Run a catalog query. A missing `input_support` column is treated as every game being `unknown`. */
export async function readWithInputSupport<T>(hideDesktop: boolean, run: (applyFilter: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(hideDesktop);
  } catch (err) {
    if (!hideDesktop || !isMissingInputSupportColumn(err)) throw err;
    warnMissingInputSupport(err);
    return await run(false);
  }
}
