const NEXT_BASE = 'https://next.invalid';

export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(next)) return fallback;
  let u: URL;
  try {
    u = new URL(next, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== NEXT_BASE) return fallback;
  return u.pathname + u.search + u.hash;
}
