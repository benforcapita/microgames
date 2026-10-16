# Money-copy guard

Rendered pages and shipped assets make no creator-revenue numbers or payment promises (PAY-1) and contain no money/payment terms at all (NM-1 strict); the guard fails the build-time check and the smoke run if any slip in.

## Sub-features

- `copy-source` `npm run check:copy` scans user-rendered sources (`src/pages`, `src/components`, `src/layouts`, browser `src/lib/*.ts`, `cdn/`, `public/`).
- `copy-dist` `npm run check:copy -- --dist` also scans the built output (the CI gate).
- `copy-rendered` `/` and `/creators` HTML contain no hits from `findMoneyClaims` / `findPaymentPromises` / `findSiteMoneyTerms` (smoke `NM-1 strict` checks).
- `copy-unit` `src/lib/money-claims.test.ts`, `src/lib/site-copy.test.ts`.

## How to get to it (user POV)

- Visit `/`, `/creators`, `/games`, a game page, `/upload` and read the copy.

## Driving it with vmg.sh

Preconditions:

- Checkout with `npm ci`; for the rendered check, `$V up && $V web`.

- **Source + dist.** `npm run build && npm run check:copy -- --dist` → `site copy: clean (…)`, exit 0. Tee into `$($V evidence money-copy-guard)/check-copy.txt`.
- **Rendered pages.** `for p in / /creators /games /upload /play/stack-tower; do curl -s http://127.0.0.1:55668$p > $D/$(echo $p|tr / _).html; done` then `$V exec -- node --input-type=module -e 'import {findMoneyClaims,findPaymentPromises,findSiteMoneyTerms} from "./src/lib/money-claims.ts"; import fs from "node:fs"; for (const f of process.argv.slice(1)) { const h=fs.readFileSync(f,"utf8"); console.log(f, JSON.stringify([...findMoneyClaims(h),...findPaymentPromises(h),...findSiteMoneyTerms(h)])) }' $D/*.html` → every line ends `[]`.
- **Negative control.** Temporarily add a term to a scratch copy (not the repo) and run `scanText` from `scripts/check-site-copy.mjs` on it to see the guard fire; never commit it.
- **Production (GET-only).** `curl -s https://meshground.com/ > $D/prod-home.html` and run the same node check.

## Gotchas

- `/upload` is login-gated: a signed-out curl gets the 302 body, not the form. Fetch it with the cookie jar from `upload-submission.md`.
- Backend code (`src/lib/server`, `supabase/`, `scripts/`) is intentionally out of scope; hits there are not violations.
- Comments are stripped before scanning; a term in a comment is not a failure, but the same term in a string literal is.
