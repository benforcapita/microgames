# Meshground

Open exchange for single-file browser games (Three.js etc.). Astro 7 SSR (`@astrojs/node`) on Supabase: Postgres (via `postgres.js` + `DATABASE_URL`), Auth (`@supabase/ssr` cookies), Storage (private `games` bucket). Requires Node ≥ 22.13 and Docker for the local Supabase stack.

## Commands
- `npm run db:start` / `npm run db:stop` — local Supabase stack (applies `supabase/migrations/*`); Mailpit inbox for auth emails at http://127.0.0.1:54324
- `npm run seed` — demo games into the configured Supabase with zero plays/ratings (`-- --force` replaces them and their stats; `-- --synthetic-plays` adds fake sessions/ratings for local health/eligibility testing only)
- `npm run admin:grant -- <handle> [--revoke]` — sets `profiles.role` to `admin` (unlocks `/admin`); `npx supabase migration up --local` applies pending migrations to the running local stack without wiping data
- `npm run dev` — portal on http://localhost:4321 **and** the game CDN on http://localhost:4322 (both required; loads `.env`)
- `npm run check` — `astro check` (types); `npm run build` — production build; `npm start` runs built portal + CDN
- `npm run launch:video` — renders the launch film (`launch/video.html` + synthesized soundtrack) to `launch/out/meshground-launch.mp4` (needs ffmpeg + Playwright Chromium); `node launch/render.mjs --stills 3,24` for quick PNG checks; open `launch/video.html` directly to preview
- Env vars: see `.env.example`. `.env` (gitignored) points at the local stack by default.

## Architecture
- `supabase/migrations/` — schema (profiles, games, sessions, ratings, saves) + `games` bucket. RLS on, no policies: all access goes through the server.
- Session admission is Postgres-backed (`public.session_admissions` via `admitSessionStart` in `src/lib/server/abuse.ts`, ip subject = daily HMAC under `MG_IP_HASH_SECRET`): a database outage or missing table blocks all new sessions (fail closed).
- `src/middleware.ts` — per-request Supabase client, `getClaims()` → `locals.user` / `locals.profile`; signed-in users without a handle are sent to `/onboarding`
- `src/lib/server/` — `config.ts` (env), `db.ts` (postgres.js), `supabase.ts` (request client + service-role `admin`), `games.ts`, `profiles.ts`, `saves.ts`, `auth.ts` (`safeNext` redirect guard)
- Auth: `/login` (password, sign up, magic link) → `/api/auth/login`; email links land on `/auth/callback` (PKCE `code` or `token_hash`)
- `scripts/game-cdn.mjs` — separate cookieless origin; reads bundles from Storage with the secret key, injects `cdn/boot.js`, sends a CSP with `sandbox`
- `cdn/boot.js` — in-game runtime: rAF/clock/audio pause, localStorage shim, telemetry, `window.Meshground`
- `src/client/player.ts` — portal side of the postMessage protocol (telemetry, ads, saves → `/api/saves/:gameId` when logged in, else browser localStorage)
- `public/EXCHANGE_SDK.md` — prompt file creators paste into their AI coding tool; keep message types in sync with `player.ts` / `boot.js`
- PWA: `public/manifest.webmanifest`, `public/sw.js` (never caches HTML; only `/_astro/` + `/icons/`, offline fallback `public/offline.html`; bump `VERSION` to evict), icons in `public/icons/`. `src/components/InstallPrompt.astro` + `src/client/install-prompt.ts` (rendered by `Layout.astro`) show a phone-only install banner: native prompt via `beforeinstallprompt` on Android, Share → Add to Home Screen instructions on iOS; "Not now" snoozes 14 days (`localStorage['mg:install-dismissed']`)
- Game iframes use `sandbox="allow-scripts allow-pointer-lock"` — never add `allow-same-origin`
- Uploading, rating, and cloud saves require login; playing does not.
- Upload form lives on `/me#upload` (`src/components/UploadSection.astro`); `/upload` is a redirect alias that also carries `?fork=`. `/me` therefore gets the blob `frame-src` CSP.
- Admin (`profiles.role = 'admin'`, `isAdmin()` in `profiles.ts`): `/admin` (analytics + MR-1 review queue from `games_awaiting_review`), `/admin/games`, `POST /api/admin/games/:id/review` (`decision=approve|reject`, reject needs `note`). Transition rules are pure in `src/lib/admin-rules.ts`; admins can open pending games on `/play` and `/submissions` via `reviewerPreviewToken`.
- Share links (SL-1..SL-5): creators of a `pending` game mint timed links on `/submissions/<id>` (`PreviewLinks.astro` → `POST /api/submissions/:id/preview-links` with `{ ttlHours: 1|24|72|168 }`, default 24; revoke `POST …/preview-links/:linkId/revoke`). Pure rules (lifetimes, which version a link pins, expiry text) live in `src/lib/preview-link-rules.ts`; DB access in `src/lib/server/preview-links.ts`. Friends open `/p/<token>` (no login): `resolve_preview_link` → `openPreviewLink` mints a version-pinned CDN token. Only the token hash is stored; caps are 5 active links and 10 per hour (SQL in `supabase/migrations/*preview_link*`). Docs page `/preview-links`; README "Preview links".
- MCP (MCP-1): `mcp/meshground-mcp.mjs` is a zero-dependency stdio MCP server (tools `get_sdk_guide`, `publish_game`, `list_my_games`, `update_game`; generates a PNG thumbnail when none is given). Served from `/downloads/meshground-mcp.mjs` with the site origin baked in (don't serve it under `/mcp/…`: Vite would serve the repo file there in dev). Creators mint personal tokens on `/me#mcp` (`McpSection.astro`, `POST /api/tokens`, revoke `POST /api/tokens/:id/delete`); only SHA-256 hashes live in `api_tokens`. The token API is `/api/v1/games` (GET list, POST publish JSON) and `/api/v1/games/:id` (GET status + checks, PUT replace HTML). It is Bearer-only: middleware skips cookie auth under `/api/v1/`. Publish reuses `validateGameUpload`/`planGameUpload`; `replaceGameBundle` only accepts pending/rejected games with no uploaded assets and re-queues validation.

## Verification
- `npm run check` and `npm run build` must pass
- Smoke test: curl pages return 200 (protected pages 302 to `/login`)
- Auth flows can be scripted with curl + a cookie jar (send an `Origin` header on POSTs); magic links are readable via the Mailpit API (`/api/v1/search?query=to:<email>`)
- MCP server: `mcp/meshground-mcp.test.ts` drives it against a fake API; for a live check, mint a token via `/api/tokens` (cookie session), download `/downloads/meshground-mcp.mjs`, run it with `MESHGROUND_TOKEN`, and send JSON-RPC lines on stdin
- In-iframe behaviour: headless Chrome over CDP, launched with `--disable-site-isolation-trials` to evaluate inside the game frame
