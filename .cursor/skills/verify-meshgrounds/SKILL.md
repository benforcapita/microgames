---
name: verify-meshgrounds
description: "Drive the Meshground(s) game exchange (Astro portal + separate-origin game CDN on a local Supabase stack) the way a visitor/creator does and capture proof. Use when you need to prove portal, play, upload, CDN /g/ route, auth (magic link via Mailpit) or site-copy behavior in benforcapita/microgames, or before handing a change to review."
---

# Verify Meshgrounds

Repo: `benforcapita/microgames` (package `meshground`). The user surface is the web portal (Astro 7 SSR,
`src/pages/`) plus the cookieless game CDN (`scripts/game-cdn.mjs` → `cdn/handler.mjs`) that serves game
HTML into `sandbox="allow-scripts allow-pointer-lock"` iframes. Data, auth and storage come from Supabase.
Secondary surfaces: the API routes under `src/pages/api/`, the `validate-game` edge function (not run here).

Everything goes through one helper: `.cursor/skills/verify-meshgrounds/scripts/vmg.sh` (run from the
repo/worktree root). Below, `V=.cursor/skills/verify-meshgrounds/scripts/vmg.sh`.

## Safety rules (non-negotiable)

1. **Local isolated stack only.** Every run gets its own Supabase `project_id` and a 10-port block
   (`VMG_PROJECT_ID`, `VMG_PORT_BASE`; defaults `vmg` / `55660`-`55669`). `$V up` edits
   `supabase/config.toml` (project_id, api/db/shadow/pooler/studio/smtp/analytics/inspector ports, auth
   `site_url` + `additional_redirect_urls` for the portal port) after backing it up to
   `/tmp/vmg-state-<id>/config.toml.orig`; `$V down` restores it and checks `git diff` is clean.
   Keep the edit in place for the whole run: `supabase status` (used by smoke, Playwright and `vmg.sh`)
   reads `project_id` from that file, and with the original `microgames` id it would report *someone
   else's* stack. Other QA jobs use the 556xx range and their own ids: pick an unused id and block
   (`docker ps`, `ss -ltn`); `$V up` refuses if any port in the block is taken or the id is running.
2. **Scrub hosted credentials.** `vmg.sh` unsets `MESHGROUNDS_DATABASE_URL`,
   `MESHGROUNDS_SUPABASE_SECRET_KEY`, `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN` before anything runs and
   only exports env derived from `supabase status` of *our* project, refusing any URL that is not
   `127.0.0.1:<our port>` (`DATABASE_URL` must be `…@127.0.0.1:$((BASE+1))/…`). If you run anything
   outside `vmg.sh`, `unset` those four first and verify the host:
   `node -e 'console.log(new URL(process.env.DATABASE_URL).host)'` → `127.0.0.1:<our db port>`.
3. **Never touch hosted Supabase or Vercel.** No `supabase link/db push/functions deploy`, no Vercel
   MCP/CLI writes, no `npm run check:pg-net` against hosted. Checks against production
   (`https://www.meshground.app`, `https://meshgrounds.vercel.app`, the CDN) are **GET/HEAD only**: no POST,
   no form submissions, no login, no uploads, no telemetry beacons (so no headless browser that clicks
   Play on prod — it POSTs `/api/telemetry`). `curl -sI` / `curl -s -o /dev/null -D -` only.
4. **Kill only your own PIDs.** `vmg.sh` records portal/CDN PIDs in `/tmp/vmg-state-<id>/*.pid` (started
   with `setsid`, killed by that process group). Never `pkill node`, `killall`, `docker stop $(docker ps -q)`,
   `supabase stop --all`, or `npm run db:stop` (that stops whatever `project_id` the config names).
   Stop the stack only with `supabase stop --project-id <your id>` (what `$V down` does).
5. **Never print secrets.** Keys stay in process env; `vmg.sh` filters key/secret/jwt lines from
   `supabase start` output and never echoes env. Don't run `supabase status` without `-o json` piped into
   code, don't `env`/`printenv`, don't paste magic-link tokens (redact `token=`).
6. **Evidence survives cleanup** in `/workspace/verify-evidence/meshgrounds/<run-id>/` (outside the repo
   and outside `/tmp/vmg-state-*`). `$V down` copies the run logs there and deletes only the state dir.
7. **CI does not run DB tests.** `.github/workflows/ci.yml` runs only `npm ci`, `check`, `build`,
   `check:copy -- --dist`. The DB-backed node tests (`supabase/tests/*.test.ts`,
   `src/lib/server/visibility.db.test.ts`, …), `npm run smoke` and Playwright `e2e/` run **only** when you
   run them locally — so run the full suite (below) for any change, and require `# skipped 0`: the DB
   tests silently `t.skip()` when they can't reach the DB (they default to port 54322, someone else's stack).

## Launch

Prereqs: Docker, Node 22 at `/workspace/node22/bin` (vmg.sh prepends it; repo wants >=22.13, `.nvmrc`
22), `npm ci` done in the checkout, Playwright Chromium in `~/.cache/ms-playwright` (`npx playwright install chromium` if missing).

```bash
cd <worktree>; V=.cursor/skills/verify-meshgrounds/scripts/vmg.sh
export VMG_PROJECT_ID=vmg VMG_PORT_BASE=55660 VMG_RUN_ID=$(date +%Y%m%d-%H%M%S)-<topic>
$V up      # ~30s warm: edits config, `supabase start -x vector,logflare,edge-runtime,imgproxy,realtime`,
           # migrations, then `node scripts/seed.mjs --force` (3 seed games, 0 plays). Ready line:
           # "[vmg] stack up and seeded. evidence dir: /workspace/verify-evidence/meshgrounds/<run-id>"
$V web     # astro build + node dist/server/entry.mjs on :BASE+8 and scripts/game-cdn.mjs on :BASE+9
           # Ready line: "[vmg] web ready http://127.0.0.1:55668  cdn http://127.0.0.1:55669 (pids …)"
           # (VMG_SKIP_BUILD=1 reuses dist/). Ready = /login 200 AND CDN serves seed game stk7wr01.
```

Ports in a block: api BASE, db +1, shadow +2, pooler +3, studio +4, Mailpit +5, analytics +6,
edge inspector +7, portal +8, CDN +9. `$V exec -- <cmd>` runs any command with the local env injected
(`PUBLIC_SUPABASE_URL`, keys, `DATABASE_URL`, `MAILPIT_URL`, `SITE_URL`, `MG_CDN_*`, `MG_WEB_ORIGINS`,
`SMOKE_*`/`E2E_*` ports = the block's portal/CDN ports, a random `CDN_PREVIEW_SECRET`, and
`NODE_OPTIONS=--experimental-strip-types`). Teardown: see Cleanup.

## Doctor

`$V doctor` — read-only, exit 0 means worth driving. Checks: the four hosted vars are unset (and reports
which were scrubbed from your shell); `config.toml` has our `project_id` and a backup exists; ≥5 containers
`*_<id>` running; `supabase status` is loopback on our API port; auth `/auth/v1/health`; Mailpit API;
DB query (`games=… live=… migrations=…`) with all `supabase/migrations/*.sql` applied; portal/CDN PIDs alive
and owning their ports (`ss -ltnp`); prints git rev and evidence dir. Run it after `up`, after `web`, and
whenever anything looks off. Never drive an instance whose doctor fails or that you didn't start.

## Drive

- **Browser (preferred for user paths):** Playwright from the repo's own `@playwright/test`, Chromium
  launched with `--disable-site-isolation-trials` (same as `playwright.config.mjs`) so you can evaluate in
  the opaque-origin game frame. Shipped recipe: `$V exec -- node .cursor/skills/verify-meshgrounds/scripts/drive-play.mjs <outDir> [gameId] [title]`.
  Quick page proof: `$V shot http://127.0.0.1:55668/<path> <out>.png` (also writes `<out>.aria.txt`).
  Stable handles: buttons `Play <title>`, `Email me a link`, `Submit for validation`, `Use this preview`;
  `iframe.mg-frame`; form fields by `name=` (`email`, `password`, `mode`, `game`, `thumb`, `title`,
  `license`, `agree`); nav `aria-label="Sign-in method"`.
- **HTTP:** curl with a cookie jar; POSTs need `-H "Origin: http://127.0.0.1:55668"`. Auth form posts go
  to `/api/auth/login` (`mode=password|signup|magic`). Magic links come from Mailpit
  (`$MAILPIT_URL/api/v1/messages`, `/api/v1/message/<ID>` → `.Text`).
- **Repo harnesses (full suite):** stop the long-lived servers first (`$V stop-web`) because smoke and
  Playwright start their own portal+CDN on the same block ports, then:
  `$V exec -- npm test` (node tests incl. DB tests; require `npm test: 0 failed, 0 skipped`),
  `$V exec -- npm run smoke` (builds, seeds, 56 exact-status checks; `[smoke] OK: N checks passed`),
  `$V exec -- npx playwright test` (11 specs in `e2e/`), `npm run check`, `npm run check:copy -- --dist`.
- Feature recipes: [features/README.md](features/README.md).

## Evidence

Location: `/workspace/verify-evidence/meshgrounds/<run-id>/<feature>/` — `$V evidence <feature> [files…]`
creates it and prints the path. Per feature capture: the action (command/script + its stdout log), the
resulting state (screenshot + ARIA snapshot, response headers/bodies), and the side effect read back from
a second view (DB row via `$V exec -- node …postgres…`, Mailpit message, CDN response). Suite runs: tee
outputs into `<run-id>/suite/`. `$V down` adds `supabase-start.log`, `seed.log`, `build.log`, `web.log`,
`cdn.log`, the run's copies of any `docs/pr-assets/*` it rewrote (under `e2e-pr-assets/`), and a copy of
`test-results/screenshots/` (gitignored; where e2e writes its screenshots) under `screenshots/` if present.

Proof standards: drive the real user path (buttons, forms, routes), not internal setters or test-only
endpoints; capture action and resulting state, not just the last screen; verify side effects (rows in
`public.sessions`/`games`/`saves`, Storage objects via the CDN, Mailpit messages) alongside what's visible;
no mocks except where a production boundary already isolates the system (the mock ad overlay when
`PUBLIC_ADSENSE_CLIENT` is empty; the `validate-game` stub in `supabase/tests`). Name the feature ID and
entry point with every artifact; report an unreachable path with the command and the unmet precondition.

## Cleanup

```bash
$V down
```
Kills only the portal/CDN process groups from `/tmp/vmg-state-<id>/*.pid`, runs
`supabase stop --project-id <id> --no-backup` (drops our containers and volumes, nobody else's), restores
`supabase/config.toml` from the backup and confirms it matches HEAD, restores only the tracked
`docs/pr-assets/*` files this run changed to the snapshot `up` took (edits that existed before `up` are
kept; the run's versions go to evidence), copies `test-results/screenshots/` (if present) into evidence, copies logs to evidence, deletes the state
dir, and prints `[vmg] evidence kept: <dir> (N files)`. Then confirm: `ls <evidence dir>`,
`git status --short` (only your intended changes), `docker ps | grep _<id>` empty. Run `$V down` after
every failed attempt too; it is safe to repeat. If `up` died mid-way, `down` still restores the config.

## Helpers

- `scripts/vmg.sh {up|web|stop-web|doctor|exec -- cmd|shot <url> <png>|evidence <name> [files]|down}` — usage
  in its header (`$V` with no args prints it).
- `scripts/drive-play.mjs <outDir> [gameId=stk7wr01] [title="Stack Tower"]` — run via `$V exec -- node …`;
  browse `/games` → `/play/<id>` → click `Play <title>`; asserts slug redirect, iframe sandbox, CDN src,
  canvas, `window.Meshground`, telemetry 204s, and a new `public.sessions` row; writes PNGs, ARIA, log.

Keep the map honest as the app changes with `/maintain-verification-skill`.
