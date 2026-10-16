const NEXT_BASE = 'https://next.invalid';
/** Longer values fall back (a huge ?next= would otherwise blow up redirect headers: 431). */
export const MAX_NEXT_LENGTH = 1024;

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || next.length > MAX_NEXT_LENGTH || !next.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(next)) return fallback;
  let u: URL;
  try {
    u = new URL(next, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== NEXT_BASE) return fallback;
  const out = u.pathname + u.search + u.hash;
  if (!out.startsWith('/') || out.startsWith('//') || out.startsWith('/\\')) return fallback;
  return out.length > MAX_NEXT_LENGTH ? fallback : out;
}
