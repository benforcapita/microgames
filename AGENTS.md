# Meshgrounds

Open exchange for single-file browser games (Three.js etc.). Astro 7 SSR (`@astrojs/node`) + built-in `node:sqlite`. Requires Node ≥ 22.13.

## Commands
- `npm run dev` — portal on http://localhost:4321 **and** the game CDN on http://localhost:4322 (both required)
- `npm run build` — production build (`dist/`); `npm start` runs built portal + CDN
- Reset local data: stop the server and delete `data/` (re-seeds from `seed/` on next start)

## Architecture
- `src/lib/server/` — config, SQLite schema + auto-seed (`db.ts`), queries/telemetry/graduation (`games.ts`)
- `scripts/game-cdn.mjs` — separate cookieless origin serving `data/games/<id>/index.html`; injects `cdn/boot.js` and sends a CSP with `sandbox`
- `cdn/boot.js` — in-game runtime: rAF/clock/audio pause, localStorage shim, telemetry, `window.Meshgrounds`
- `src/client/player.ts` — portal side of the postMessage protocol (telemetry, ads, saves); `src/client/ads.ts` — AdSense H5 or mock ads
- `public/EXCHANGE_SDK.md` — prompt file creators paste into their AI coding tool; keep message types in sync with `player.ts` / `boot.js`
- Games iframes use `sandbox="allow-scripts allow-pointer-lock"` — never add `allow-same-origin`

## Verification
- `npm run build` must pass
- Smoke test: curl all pages return 200; end-to-end in-iframe behaviour can be checked with headless Chrome over CDP (launch with `--disable-site-isolation-trials` to evaluate inside the game frame)
