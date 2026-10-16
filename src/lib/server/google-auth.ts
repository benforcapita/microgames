// GA-1: "Continue with Google" (Supabase OAuth, PKCE via the SSR client). Pure logic; the routes are thin shells.
import { authEmailRedirect } from './email-redirect';
import { safeNext } from './safe-next';

/**
 * Sign-in error CODES. Only these ever go into /login?error=; the page renders the fixed text below.
 * Raw Supabase / provider messages are logged server-side and never reach the URL or the page.
 */
export const AUTH_ERROR_TEXT = {
  google_unavailable: "Google sign-in isn't available yet.",
  bad_origin: "Sign-in can't be started from this address.",
  cancelled: 'Sign-in was cancelled.',
  link_expired: 'That sign-in link is invalid or has expired. Please try again.',
  other_browser: 'Please finish signing in in the same browser you started in.',
  signin_failed: "Sign-in didn't work. Please try again.",
} as const;
export type AuthErrorCode = keyof typeof AUTH_ERROR_TEXT;
export const isAuthErrorCode = (v: unknown): v is AuthErrorCode => typeof v === 'string' && Object.hasOwn(AUTH_ERROR_TEXT, v);

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

const back = (next: string, error: AuthErrorCode) => {
  const q = new URLSearchParams({ error });
  if (next !== '/') q.set('next', next);
  return `/login?${q}`;
};

/** Where to send the browser: Google's consent URL, or back to /login with a friendly error. Never throws. */
export async function startGoogleSignIn(input: StartInput): Promise<string> {
  const next = safeNext(input.next);
  // Same allowlisted origin as auth emails: never SITE_URL, never an attacker-chosen host.
  const redirectTo = authEmailRedirect({ requestUrl: input.requestUrl, next, originHeader: input.originHeader, nodeEnv: input.nodeEnv });
  if (!redirectTo) return back(next, 'bad_origin');
  try {
    if (!(await input.providerEnabled())) return back(next, 'google_unavailable');
    const { data, error } = await input.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error || !data?.url) return back(next, 'google_unavailable');
    return data.url;
  } catch {
    return back(next, 'google_unavailable');
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

/** Code for a provider `?error=` on the callback (Google OAuth, or an expired email link, reported the same way). */
export function callbackErrorCode(error: string, errorCode?: string | null): AuthErrorCode {
  if (errorCode === 'otp_expired') return 'link_expired';
  return error === 'access_denied' ? 'cancelled' : 'signin_failed';
}

/** Code for a failed exchangeCodeForSession / verifyOtp, from the AuthError's stable `code` (never its message). */
export function exchangeErrorCode(err: { code?: unknown; name?: unknown } | null | undefined): AuthErrorCode {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'pkce_code_verifier_not_found' || err?.name === 'AuthPKCECodeVerifierMissingError') return 'other_browser';
  if (code === 'flow_state_not_found' || code === 'flow_state_expired' || code === 'otp_expired') return 'link_expired';
  return 'signin_failed';
}

/** Leftover PKCE verifier cookies (fixed key, per-flow slots, flow index; any chunk) to clear after sign-in. */
export const VERIFIER_COOKIE_RE = /^sb-[A-Za-z0-9_-]+-code-verifier(\.\d+)?$/;
export const leftoverVerifierCookies = (names: string[]) => names.filter((n) => VERIFIER_COOKIE_RE.test(n));

/** After a session exists: users without a profile (no handle yet) go to onboarding first. */
export function afterSignIn(hasProfile: boolean, next: string): string {
  if (hasProfile) return next;
  return next === '/' ? '/onboarding' : `/onboarding?${new URLSearchParams({ next })}`;
}
