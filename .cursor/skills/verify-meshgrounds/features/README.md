# Meshgrounds verification map

This directory is the maintained source for verifying the user-facing behavior of Meshground (portal + game CDN). Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- A worktree with `npm ci` done; `V=.cursor/skills/verify-meshgrounds/scripts/vmg.sh` run from its root.
- An isolated stack started by this run: `VMG_PROJECT_ID=<unused id> VMG_PORT_BASE=<free 10-port block> $V up` (examples below use `vmg` / 55660, so portal `http://127.0.0.1:55668`, CDN `http://127.0.0.1:55669`, Mailpit `http://127.0.0.1:55665`).
- Seed state after `up`: live games `Stack Tower` (`stk7wr01`, creator `polyprism`) and `Neon Lanes` (`neon1an3`, `vhs_vector`); proving game `Prism Pop` (`pr1smp0p`, `polyprism`); zero plays and ratings.
- `$V web` for browser/curl recipes; `$V stop-web` before `npm run smoke` or `npx playwright test` (they start their own servers on the same ports).
- `$V doctor` exits 0. Never drive an instance that was not started by this verification run.

## Driving conventions

- Run every command through `$V exec -- …` so env is loopback-only and secrets are never printed.
- Prefer role + accessible name (`button "Play Stack Tower"`), form `name=` attributes, and route paths over CSS position.
- Every POST carries `Origin: http://127.0.0.1:55668` (the portal's CSRF check).
- Use fresh identities per run: `vmg-<run-id>@example.test`. Leave seed games untouched; `$V down` drops the whole stack.
- Production is GET/HEAD only. None of these recipes run against prod except the read-only header checks explicitly marked so.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof: screenshot + ARIA snapshot (`$V shot` or the driver scripts) into `$V evidence <feature-id>`.
- HTTP proof: request line, status, and the headers asserted (`curl -D <file>`).
- Mutation proof: a read-only second view (DB `select` via `$V exec -- node`, Mailpit API, CDN fetch).
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with vmg.sh`, `Gotchas`.

## Features

- [Browse and play a game](./play-game.md) covers catalog, slug redirect, sandboxed CDN iframe, telemetry, and the play row in the DB.
- [Upload a submission](./upload-submission.md) covers the upload form, the pending submission page, owner preview, and the proving/live stages.
- [Game CDN `/g/` route](./cdn-route.md) covers CSP/frame-ancestors, CORS for source and versioned assets, caching per stage, and 404s.
- [Magic-link login](./magic-link-login.md) covers password/sign-up/magic-link modes with the email read from local Mailpit.
- [Money-copy guard](./money-copy-guard.md) covers NM-1/PAY-1: no money or payment terms on rendered pages or built output.
