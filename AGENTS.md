# Meshgrounds

Open exchange for single-file browser games (Three.js etc.). Astro 7 SSR (`@astrojs/node`) on Supabase: Postgres (via `postgres.js` + `DATABASE_URL`), Auth (`@supabase/ssr` cookies), Storage (private `games` bucket). Requires Node ≥ 22.13 and Docker for the local Supabase stack.

## Commands
- `npm run db:start` / `npm run db:stop` — local Supabase stack (applies `supabase/migrations/*`); Mailpit inbox for auth emails at http://127.0.0.1:54324
- `npm run seed` — demo games + synthetic plays into the configured Supabase (`-- --force` to replace)
- `npm run dev` — portal on http://localhost:4321 **and** the game CDN on http://localhost:4322 (both required; loads `.env`)
- `npm run check` — `astro check` (types); `npm run build` — production build; `npm start` runs built portal + CDN
- `npm run launch:video` — renders the launch film (`launch/video.html` + synthesized soundtrack) to `launch/out/meshgrounds-launch.mp4` (needs ffmpeg + Playwright Chromium); `node launch/render.mjs --stills 3,24` for quick PNG checks; open `launch/video.html` directly to preview
- Env vars: see `.env.example`. `.env` (gitignored) points at the local stack by default.

## Architecture
- `supabase/migrations/` — schema (profiles, games, sessions, ratings, saves) + `games` bucket. RLS on, no policies: all access goes through the server.
- `src/middleware.ts` — per-request Supabase client, `getClaims()` → `locals.user` / `locals.profile`; signed-in users without a handle are sent to `/onboarding`
- `src/lib/server/` — `config.ts` (env), `db.ts` (postgres.js), `supabase.ts` (request client + service-role `admin`), `games.ts`, `profiles.ts`, `saves.ts`, `auth.ts` (`safeNext` redirect guard)
- Auth: `/login` (password, sign up, magic link) → `/api/auth/login`; email links land on `/auth/callback` (PKCE `code` or `token_hash`)
- `scripts/game-cdn.mjs` — separate cookieless origin; reads bundles from Storage with the secret key, injects `cdn/boot.js`, sends a CSP with `sandbox`
- `cdn/boot.js` — in-game runtime: rAF/clock/audio pause, localStorage shim, telemetry, `window.Meshgrounds`
- `src/client/player.ts` — portal side of the postMessage protocol (telemetry, ads, saves → `/api/saves/:gameId` when logged in, else browser localStorage)
- `public/EXCHANGE_SDK.md` — prompt file creators paste into their AI coding tool; keep message types in sync with `player.ts` / `boot.js`
- Game iframes use `sandbox="allow-scripts allow-pointer-lock"` — never add `allow-same-origin`
- Uploading, rating, and cloud saves require login; playing does not.

## Verification
- `npm run check` and `npm run build` must pass
- Smoke test: curl pages return 200 (protected pages 302 to `/login`)
- Auth flows can be scripted with curl + a cookie jar (send an `Origin` header on POSTs); magic links are readable via the Mailpit API (`/api/v1/search?query=to:<email>`)
- In-iframe behaviour: headless Chrome over CDP, launched with `--disable-site-isolation-trials` to evaluate inside the game frame
