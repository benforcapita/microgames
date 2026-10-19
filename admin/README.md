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

`.env.example` contains placeholders only. Until `ADMIN_PATH_SECRET` is a real
random value (>= 32 chars of `[A-Za-z0-9_-]`), a real user, and
`ADMIN_PASSWORD_HASH` a real hash, every request returns a plain 503 — the app
fails closed. Astro loads `.env` automatically for `dev` and `build`.

## Hashing a password

```sh
npm run hash-password   # reads from stdin with no echo; also accepts a pipe
```

Prints an argon2id PHC string (`$argon2id$...`, m=19456, t=2, p=1) to put in
`ADMIN_PASSWORD_HASH`. The password is never printed.

## Checks

```sh
npm run check   # astro check
npm test        # node:test over test/*.test.ts
npm run build   # Vercel build; the static output must stay empty
```

There are no static assets, no client JavaScript and no `public/` folder on
purpose: Vercel serves static files without running middleware, which would
bypass the locks and fingerprint the app.

## Layout

- `src/middleware.ts` — lock 1 (secret path) → lock 2 (basic auth) →
  lock 3 slot (MGA-2b) → security headers → CSRF on POST
- `src/lib/config.ts` — boot env validation, fails closed (503 everywhere)
- `src/lib/auth-basic.ts` — constant-time basic auth (argon2id / bcrypt)
- `src/lib/csrf.ts` — `__Host-mga_csrf` cookie + HMAC field (HKDF key from
  `ADMIN_PATH_SECRET`, label `mga-csrf-v1`)
- `src/lib/log.ts` — JSON-lines logger, allowlisted fields only
- `src/pages/[p]/` — all routes under the dynamic prefix (placeholder +
  SSR `admin.css`); `src/pages/robots.txt.ts`; `src/pages/[...any].ts` plain 404
- `scripts/hash-password.mjs` — password → argon2id hash helper
