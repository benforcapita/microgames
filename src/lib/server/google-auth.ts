// GA-1: "Continue with Google" (Supabase OAuth, PKCE via the SSR client). Pure logic; the routes are thin shells.
import { authEmailRedirect } from './email-redirect';
import { safeNext } from './safe-next';

export const GOOGLE_UNAVAILABLE = "Google sign-in isn't available yet.";
export const SIGN_IN_CANCELLED = 'Sign-in was cancelled.';
export const SIGN_IN_FAILED = "Sign-in didn't work. Please try again.";
export const LINK_EXPIRED = 'That sign-in link is invalid or has expired.';
export const GOOGLE_BAD_ORIGIN = "Google sign-in can't be started from this address.";

type OAuthResult = { data: { url: string | null } | null; error: { message: string } | null };
export interface GoogleAuthClient {
  signInWithOAuth(args: { provider: 'google'; options: { redirectTo: string } }): Promise<OAuthResult>;
}

export interface StartInput {
  auth: GoogleAuthClient;
  requestUrl: URL;
  originHeader?: string | null;
  next: unknown;
  /** Whether Supabase Auth has the Google provider enabled (see googleEnabled). */
  providerEnabled: () => Promise<boolean>;
  nodeEnv?: string;
}

const back = (next: string, error: string) => {
  const q = new URLSearchParams({ error });
  if (next !== '/') q.set('next', next);
  return `/login?${q}`;
};

/** Where to send the browser: Google's consent URL, or back to /login with a friendly error. Never throws. */
export async function startGoogleSignIn(input: StartInput): Promise<string> {
  const next = safeNext(input.next);
  // Same allowlisted origin as auth emails: never SITE_URL, never an attacker-chosen host.
  const redirectTo = authEmailRedirect({ requestUrl: input.requestUrl, next, originHeader: input.originHeader, nodeEnv: input.nodeEnv });
  if (!redirectTo) return back(next, GOOGLE_BAD_ORIGIN);
  try {
    if (!(await input.providerEnabled())) return back(next, GOOGLE_UNAVAILABLE);
    const { data, error } = await input.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error || !data?.url) return back(next, GOOGLE_UNAVAILABLE);
    return data.url;
  } catch {
    return back(next, GOOGLE_UNAVAILABLE);
  }
}

/**
 * Supabase builds the authorize URL locally, so a disabled provider only fails once the browser gets there.
 * Ask Auth's public settings instead (no flow state is created). Cached briefly; any failure counts as disabled.
 */
export function googleEnabled(supabaseUrl: string, publishableKey: string, fetchImpl: typeof fetch = fetch, ttlMs = 60_000) {
  let cached: { value: boolean; at: number } | null = null;
  return async (): Promise<boolean> => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    let value = false;
    try {
      const res = await fetchImpl(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publishableKey }, signal: AbortSignal.timeout(3000) });
      value = res.ok && (await res.json())?.external?.google === true;
    } catch {
      value = false;
    }
    cached = { value, at: Date.now() };
    return value;
  };
}

/**
 * Friendly text for an `?error=` on the callback (Google OAuth, or an expired email link, which Auth reports
 * the same way). Never echoes provider text into the page.
 */
export function callbackErrorMessage(error: string, errorCode?: string | null): string {
  if (errorCode === 'otp_expired') return LINK_EXPIRED;
  return error === 'access_denied' ? SIGN_IN_CANCELLED : SIGN_IN_FAILED;
}

/** After a session exists: users without a profile (no handle yet) go to onboarding first. */
export function afterSignIn(hasProfile: boolean, next: string): string {
  if (hasProfile) return next;
  return next === '/' ? '/onboarding' : `/onboarding?${new URLSearchParams({ next })}`;
}
