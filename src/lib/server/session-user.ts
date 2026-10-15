const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Auth user id from a JWT `sub`, or null for an anonymous visitor or an unusable claim. */
export function sessionUserId(sub: unknown): string | null {
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  return sub.toLowerCase();
}

/**
 * True when the request carries a Supabase auth cookie (including chunked cookies).
 * A PKCE code-verifier cookie does not count.
 */
export function hasAuthSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return /(?:^|;)\s*sb-[^=;\s]*auth-token(?:\.\d+)?=/.test(cookieHeader);
}
