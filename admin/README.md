# Meshgrounds admin

Standalone Astro 7 SSR package for the private admin app. Built only by the
`meshgrounds-admin` Vercel project — never by the public site.

Every response outside the secret path is the same plain 404; the app is
invisible without the secret path and the basic-auth password, and every
response carries the strict security headers.

## Run locally

Requires Node >= 22.13.

```sh
npm ci
cp .env.example .env   # then replace every placeholder
npm run dev            # http://localhost:56905
```

`.env.example` contains placeholders only. Every request returns a plain 503 —
the app fails closed — until all boot-checked settings are real values:
`ADMIN_PATH_SECRET` (>= 32 chars of `[A-Za-z0-9_-]`), `ADMIN_USER`,
`ADMIN_PASSWORD_HASH`, `ADMIN_DATABASE_URL`, `ADMIN_ORIGIN` (an exact
https origin — no path, no trailing slash — that is not `meshground.app`, a
subdomain of it, or `meshgrounds.vercel.app`), `ADMIN_USER_ID` (a UUID, stored and compared lowercase),
`ADMIN_SUPABASE_URL` (https only) and `ADMIN_SUPABASE_ANON_KEY` (non-empty,
rejected if it contains whitespace).
Astro loads `.env` automatically for `dev` and `build`.

## Hashing a password

```sh
npm run hash-password   # reads from stdin with no echo; also accepts a pipe
```

Prints an argon2id PHC string (`$argon2id$...`, m=19456, t=2, p=1) to put in
`ADMIN_PASSWORD_HASH`. The password is never printed.

## Checks

```sh
npm run check    # astro check
npm test         # node:test over test/*.test.ts (unit tests only)
npm run test:db  # node:test over test/*.db.test.ts; skips when the local stack is down
npm run build    # Vercel build; the static output must stay empty
```

The lockout counts `admin_auth_failures` rows in the database, so repeated
wrong passwords are locked across function instances: 5 failures within 15
minutes → 429 with `Retry-After` until the window clears. A success deletes
all rows. The lockout db test expects `DATABASE_URL` pointing at a local
Supabase stack with the MGA-1 migration applied.

## Lock 3

Every page except the stylesheet and the auth routes (which have no pages
yet) requires a Supabase session for `ADMIN_USER_ID` at AAL2 with a verified
TOTP factor. Anything else, including an Auth error, is the same plain 404
as a wrong path. `ADMIN_SUPABASE_URL` has to be https. Local Auth is
`http://127.0.0.1:54321`, and that URL is rejected at boot on purpose, so
`npm run dev` will answer 503 if `.env` points at it.

To run lock 3 against the local stack, from the repo root:

```sh
npm run db:start          # Docker; local Auth only
cd admin && npm run test:db
```

`test:db` keeps an https placeholder in the env and injects a loopback Auth
client. It creates two users at runtime, enrolls a TOTP factor from a secret
generated in the test, and deletes the users afterwards. Passwords, secrets
and codes are not printed. Local TOTP enroll and verify are on in
`supabase/config.toml` under `[auth.mfa.totp]`. Whether a hosted project has
TOTP enabled is separate (MGA-7).

There are no static assets, no client JavaScript and no `public/` folder on
purpose: Vercel serves static files without running middleware, which would
bypass the locks and fingerprint the app.

## Layout

- `src/middleware.ts` — lock 1 (secret path) → lock 2 (basic auth) →
  lock 3 (Supabase session, AAL2, verified TOTP) → Origin + CSRF on non-GET,
  then the security headers
- `src/lib/config.ts` — boot env validation, fails closed (503 everywhere)
- `src/lib/auth-basic.ts` — constant-time basic auth (argon2id / bcrypt) +
  DB-backed lockout gate
- `src/lib/auth-supabase.ts` — per-request Auth client, `getUser()` plus AAL2
  and a verified TOTP factor; every `Set-Cookie` is HttpOnly, Secure,
  SameSite=Strict, Path=/
- `src/lib/db.ts` — postgres.js client for `ADMIN_DATABASE_URL` and the
  `admin_auth_failures` store
- `src/lib/csrf.ts` — `__Host-mga_csrf` cookie + HMAC field (HKDF key from
  `ADMIN_PATH_SECRET`, label `mga-csrf-v1`)
- `src/lib/log.ts` — JSON-lines logger, allowlisted fields only
- `src/pages/[p]/` — all routes under the dynamic prefix (placeholder +
  SSR `admin.css`); `src/pages/robots.txt.ts`; `src/pages/[...any].ts` plain 404
- `scripts/hash-password.mjs` — password → argon2id hash helper
