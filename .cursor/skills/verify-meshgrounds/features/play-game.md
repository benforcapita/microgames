# Browse and play a game

A visitor (no login) finds a live game in the catalog, opens its page, presses Play, and the game boots inside a sandboxed iframe served from the separate CDN origin; the portal records a play session.

## Sub-features

- `play-catalog` `/games` (and `/`) list live games; proving games are not listed.
- `play-redirect` `/play/<id>` 301s to `/play/<slug>`.
- `play-frame` Play loads `iframe.mg-frame` with `sandbox="allow-scripts allow-pointer-lock"` from `<CDN>/g/<id>/index.html`.
- `play-runtime` the injected runtime exposes `window.Meshground` and a canvas renders.
- `play-telemetry` `session_start` / `first_frame` beacons return 204 and create a `public.sessions` row.
- `play-proving-direct` a proving game is playable by direct link, `noindex`, listed nowhere.

## How to get to it (user POV)

- Click a game card on `/games` or `/`.
- Open a shared link `/play/<id>` or `/play/<slug>`.
- Proving games: direct link only (`/play/pr1smp0p`).

## Driving it with vmg.sh

Preconditions:

- `$V up && $V web`; `$V doctor` exit 0; seed state as in the README (sessions empty).

- **Full journey (scripted).** Run `D=$($V evidence play-game) && $V exec -- node .cursor/skills/verify-meshgrounds/scripts/drive-play.mjs "$D"`. Expected log: `PASS /games lists "Stack Tower"`, `PASS /play/stk7wr01 redirected to slug /play/stack-tower`, `PASS iframe sandbox="allow-scripts allow-pointer-lock"`, `PASS iframe src on CDN origin: http://127.0.0.1:55669/g/stk7wr01/index.html?embed=…`, `PASS canvas visible…`, `PASS window.Meshground inside frame: object`, `PASS telemetry: 204 session_start, 204 first_frame`, `PASS DB public.sessions rows for stk7wr01: 0 -> 1`, final `PASS`. Artifacts: `01-games.png`, `02-play-before.png`, `03-playing.png`, `03-playing.aria.txt`, `drive-play.log`.
- **Other live game.** Same script with `neon1an3 "Neon Lanes"`.
- **Proving by direct link.** Run `curl -s -o /dev/null -D - http://127.0.0.1:55668/play/prism-pop | grep -i x-robots-tag` → `noindex, nofollow`; and `curl -s http://127.0.0.1:55668/games | grep -c "Prism Pop"` → `0`. Then `drive-play.mjs "$D/proving" pr1smp0p "Prism Pop"` (its `/games lists` check is expected to FAIL here — that is the unlisted behavior; all frame checks must PASS).
- **Repo spec.** `$V stop-web && $V exec -- npx playwright test e2e/game.spec.mjs e2e/unlisted-proving.spec.mjs`.

## Gotchas

- The iframe `src` is set only after clicking Play; a curl of the play page shows no CDN iframe.
- Evaluating inside the frame needs Chromium launched with `--disable-site-isolation-trials`.
- `npm run smoke` seeds without `--force`; after smoke the sessions count is no longer 0, so compare before/after rather than absolute values.
- Playwright e2e rewrites committed screenshots in `docs/pr-assets/`; `$V down` moves them to evidence and restores the repo copies.
- Never drive Play on production: it POSTs `/api/telemetry`.
