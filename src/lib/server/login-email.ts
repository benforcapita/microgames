// One-shot flash that carries the typed email from POST /api/auth/login back to /login,
// so the address never appears in a redirect URL (history, referers, server logs).
// /login reads it once per render and deletes it; Path=/login keeps it off other routes.
export const LOGIN_EMAIL_COOKIE = 'mg_login_email';
export const LOGIN_EMAIL_PATH = '/login';
export const LOGIN_EMAIL_MAX_AGE = 60;

/** The slice of the cookie jar the helpers need (Astro's AstroCookies satisfies this). */
export interface LoginEmailJar {
  set(name: string, value: string, options: { httpOnly: true; path: string; sameSite: 'lax'; secure: boolean; maxAge: number }): void;
  get(name: string): { value: string } | undefined;
  delete(name: string, options: { path: string }): void;
}

/** Flash the typed email for the next /login render. `secure` is computed at the boundary. */
export function setLoginEmailFlash(cookies: LoginEmailJar, email: string, secure: boolean): void {
  if (!email) return;
  cookies.set(LOGIN_EMAIL_COOKIE, email, { httpOnly: true, path: LOGIN_EMAIL_PATH, sameSite: 'lax', secure, maxAge: LOGIN_EMAIL_MAX_AGE });
}

/** The flashed email, or '' when there is none. */
export function readLoginEmailFlash(cookies: LoginEmailJar): string {
  return cookies.get(LOGIN_EMAIL_COOKIE)?.value ?? '';
}

/** Burn the flash after reading (deletion must use the same Path scope). */
export function clearLoginEmailFlash(cookies: LoginEmailJar): void {
  cookies.delete(LOGIN_EMAIL_COOKIE, { path: LOGIN_EMAIL_PATH });
}
