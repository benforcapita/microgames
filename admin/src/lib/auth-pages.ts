// Shared markup and redirects for the auth routes. No client script, no
// inline style. Every redirect is a 303 to a fixed path under /<p>/.

import type { AuthKind, ReportedFactor, RequestAuth } from './auth-supabase';
import { CSRF_FIELD } from './csrf';

export const SIGN_IN_FAILED = 'Sign-in failed.';
export const VERIFY_FAILED = 'Verification failed.';
export const ENROLL_FAILED = 'Enrollment failed.';

const DESTINATIONS = {
  home: '',
  signin: '/auth/signin',
  mfa: '/auth/mfa',
  enroll: '/auth/mfa/enroll',
} as const;

export type Destination = keyof typeof DESTINATIONS;

function segmentOf(url: URL): string | undefined {
  const segment = url.pathname.split('/')[1] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  return segment;
}

export function pathUnderPrefix(url: URL, dest: Destination): string | undefined {
  const segment = segmentOf(url);
  if (!segment) return undefined;
  return `/${segment}${DESTINATIONS[dest]}`;
}

export function redirectInside(url: URL, dest: Destination): Response {
  const location = pathUnderPrefix(url, dest);
  if (!location) return plain(404, 'Not found');
  return new Response(null, { status: 303, headers: { location } });
}

export function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// Same response lock 1 builds: plain text, no charset, no redirect.
export function lockNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function document(url: URL, title: string, body: string): string {
  const segment = segmentOf(url) ?? '';
  const css = escapeHtml(`/${segment}/admin.css`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${css}">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function html(url: URL, title: string, body: string): Response {
  return new Response(document(url, title, body), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function csrfInput(field: string | undefined): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(field ?? '')}">`;
}

function errorLine(message: string | undefined): string {
  if (!message) return '';
  return `<p class="error">${escapeHtml(message)}</p>`;
}

export function signInPage(url: URL, field: string | undefined, failed: boolean): Response {
  return html(
    url,
    'Sign in',
    `${errorLine(failed ? SIGN_IN_FAILED : undefined)}
<h1>Sign in</h1>
<form method="post" action="">
${csrfInput(field)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" maxlength="320" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function mfaPage(url: URL, field: string | undefined, failed: boolean): Response {
  return html(
    url,
    'Authentication code',
    `${errorLine(failed ? VERIFY_FAILED : undefined)}
<h1>Authentication code</h1>
<form method="post" action="">
${csrfInput(field)}
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<button type="submit">Verify</button>
</form>`,
  );
}

function factorReport(factors: ReportedFactor[]): string {
  if (factors.length === 0) return '';
  const items = factors
    .map(
      (factor) =>
        `<li><code>${escapeHtml(factor.factorType)}</code> <code>${escapeHtml(factor.id)}</code></li>`,
    )
    .join('');
  return `<p>Unverified factors from earlier attempts are still on the account. They were not removed.</p><ul>${items}</ul>`;
}

export function enrollStartPage(url: URL, field: string | undefined, unverified: ReportedFactor[]): Response {
  return html(
    url,
    'Enroll authenticator',
    `${factorReport(unverified)}
<h1>Enroll authenticator</h1>
<form method="post" action="">
${csrfInput(field)}
<button type="submit">Enroll authenticator</button>
</form>`,
  );
}

export function enrollFailedPage(url: URL, field: string | undefined, unverified: ReportedFactor[]): Response {
  return html(
    url,
    'Enroll authenticator',
    `${errorLine(ENROLL_FAILED)}
${factorReport(unverified)}
<h1>Enroll authenticator</h1>
<form method="post" action="">
${csrfInput(field)}
<button type="submit">Enroll authenticator</button>
</form>`,
  );
}

export function enrollQrPage(
  url: URL,
  field: string | undefined,
  unverified: ReportedFactor[],
  qrDataUri: string,
  secret: string,
  factorId: string,
): Response {
  return html(
    url,
    'Enroll authenticator',
    `${factorReport(unverified)}
<h1>Enroll authenticator</h1>
<img class="qr" alt="Authenticator QR code" src="${escapeHtml(qrDataUri)}">
<p>If you cannot scan the code, enter this secret: <code>${escapeHtml(secret)}</code></p>
<form method="post" action="">
${csrfInput(field)}
<input type="hidden" name="factor" value="${escapeHtml(factorId)}">
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<button type="submit">Verify</button>
</form>`,
  );
}

export function enrollRetryPage(
  url: URL,
  field: string | undefined,
  unverified: ReportedFactor[],
  factorId: string,
): Response {
  const again = pathUnderPrefix(url, 'enroll') ?? '';
  return html(
    url,
    'Enroll authenticator',
    `${errorLine(VERIFY_FAILED)}
${factorReport(unverified)}
<h1>Enroll authenticator</h1>
<form method="post" action="">
${csrfInput(field)}
<input type="hidden" name="factor" value="${escapeHtml(factorId)}">
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<button type="submit">Verify</button>
</form>
<p><a href="${escapeHtml(again)}">Enroll again</a></p>`,
  );
}

export function signOutPage(url: URL, field: string | undefined): Response {
  return html(
    url,
    'Sign out',
    `<h1>Sign out</h1>
<form method="post" action="">
${csrfInput(field)}
<button type="submit">Sign out</button>
</form>`,
  );
}

export type FormFields = {
  email?: string;
  password?: string;
  code?: string;
  factor?: string;
};

export async function readForm(request: Request): Promise<FormFields> {
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return {};
  }
  const out: FormFields = {};
  const email = data.get('email');
  const password = data.get('password');
  const code = data.get('code');
  const factor = data.get('factor');
  if (typeof email === 'string' && email.length <= 320) out.email = email.trim();
  if (typeof password === 'string' && password.length <= 1024) out.password = password;
  if (typeof code === 'string' && code.length <= 16) out.code = code.trim();
  if (typeof factor === 'string' && factor.length <= 64) out.factor = factor.trim();
  return out;
}

export type Aal1Gate = { kind: 'continue'; verifiedTotp: boolean } | { kind: 'response'; response: Response };

export type EnrollGate = { kind: 'continue' } | { kind: 'response'; response: Response };

// No session, AAL2, or a verified factor: the lock-1 404. Enrollment only
// continues for Ben at AAL1 with no verified factor. Another user is signed
// out first. An Auth error is that same 404.
export async function gateEnroll(auth: RequestAuth): Promise<EnrollGate> {
  let kind: AuthKind;
  try {
    kind = await auth.classify();
  } catch {
    return { kind: 'response', response: lockNotFound() };
  }
  switch (kind.kind) {
    case 'none':
    case 'ok':
      return { kind: 'response', response: lockNotFound() };
    case 'aal1-ben':
      if (kind.verifiedTotp) return { kind: 'response', response: lockNotFound() };
      return { kind: 'continue' };
    case 'other-user':
      try {
        await auth.signOut();
      } catch {
        // signOut clears cookies even when Auth refuses the call.
      }
      return { kind: 'response', response: lockNotFound() };
    case 'error':
      return { kind: 'response', response: lockNotFound() };
    default: {
      const unreachable: never = kind;
      throw unreachable;
    }
  }
}

// AAL2 goes home. No session goes to sign-in. Another user is signed out
// and answered with the plain 404. An Auth error is that same 404.
export async function gateAal1(auth: RequestAuth, url: URL): Promise<Aal1Gate> {
  let kind: AuthKind;
  try {
    kind = await auth.classify();
  } catch {
    return { kind: 'response', response: plain(404, 'Not found') };
  }
  switch (kind.kind) {
    case 'ok':
      return { kind: 'response', response: redirectInside(url, 'home') };
    case 'other-user':
      try {
        await auth.signOut();
      } catch {
        // signOut clears cookies even when Auth refuses the call.
      }
      return { kind: 'response', response: plain(404, 'Not found') };
    case 'error':
      return { kind: 'response', response: plain(404, 'Not found') };
    case 'none':
      return { kind: 'response', response: redirectInside(url, 'signin') };
    case 'aal1-ben':
      return { kind: 'continue', verifiedTotp: kind.verifiedTotp };
    default: {
      const unreachable: never = kind;
      throw unreachable;
    }
  }
}
