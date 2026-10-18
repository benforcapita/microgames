# Game CDN `/g/` route

The cookieless CDN origin serves game documents with an injected runtime and a sandboxing CSP whose `frame-ancestors` names only the portal, serves `?source` and versioned assets with narrow CORS, caches by stage, and 404s unknown, non-public, or traversal paths.

## Sub-features

- `cdn-doc` `GET /g/<id>/index.html` → 200, `text/html`, runtime injected (`window.Meshground`), `Cache-Control: no-cache`, `Vary: Origin, Referer`.
- `cdn-csp` CSP starts `sandbox allow-scripts allow-pointer-lock; default-src 'none'` and ends `frame-ancestors <portal origins>`; a foreign Referer never appears in it.
- `cdn-source` `?source` → `text/plain`, CSP `sandbox; default-src 'none'`, `Access-Control-Allow-Origin` only for the portal origin.
- `cdn-assets` `/g/<id>/<version>/<path>` js/css/mjs/wasm: byte-for-byte, `Access-Control-Allow-Origin: null` only for `Origin: null`, `Cache-Control` `public, max-age=60, must-revalidate` for proving and live (owner-replaceable; not immutable). Served only when the asset row is uploaded, the joined game stage is public, and `updated_at <= reviewed_at`.
- `cdn-thumb` `thumb.*` → `public, max-age=3600, stale-while-revalidate=86400`.
- `cdn-deny` unknown id, pending/rejected without `pt=`, and `..`/encoded traversal → 404.

## How to get to it (user POV)

- Indirectly by pressing Play on a game page (the iframe `src`).
- `</> Source` button on a game page (fetches `?source`).
- Direct URL `http://127.0.0.1:55669/g/<id>/index.html`.

## Driving it with vmg.sh

Preconditions:

- `$V up && $V web`, doctor OK. `D=$($V evidence cdn-route); W=http://127.0.0.1:55668; C=http://127.0.0.1:55669`.

- **Embedded document.** `curl -s -o $D/game.html -D $D/game-embedded.headers -H "Referer: $W/play/stack-tower" $C/g/stk7wr01/index.html` → 200; headers show the CSP above ending `frame-ancestors http://127.0.0.1:55668 http://localhost:55668`, `Cache-Control: no-cache`; `grep -c window.Meshground $D/game.html` ≥ 1.
- **Foreign embedder.** `curl -s -o /dev/null -D $D/game-foreign.headers -H "Referer: https://evil.example/" $C/g/stk7wr01/index.html`; `frame-ancestors` still lists only the portal origins.
- **Source CORS.** `-H "Origin: $W" "$C/g/stk7wr01/index.html?source"` → `Access-Control-Allow-Origin: http://127.0.0.1:55668`; with `-H "Origin: https://evil.example"` → no `Access-Control-*` header.
- **Deny.** `curl -s -o /dev/null -w '%{http_code}' --path-as-is $C/g/stk7wr01/../../etc/passwd` → 404; `$C/g/nosuchid/index.html` → 404.
- **Proving cache/caching.** `curl -sI $C/g/pr1smp0p/index.html` → 200 `no-cache` (proving is public); versioned-asset cache headers need a game with a version folder — seed games have none, so drive them through `cdn/handler.test.ts` (`$V exec -- npm test`) and report the live-asset path as unit-covered only.
- **Production (GET-only).** `curl -s -o /dev/null -D - https://<cdn host>/g/stk7wr01/index.html` and compare CSP/Cache-Control shape. No POST, no browser.

## Gotchas

- CSP depends on `Origin`/`Referer`/`embed=`: always send the portal Referer when asserting the embedded policy.
- The CDN caches stage lookups (~30s) and objects (5 min) in memory; after changing a game's stage, restart with `$V stop-web && $V web` rather than waiting.
- `MG_WEB_ORIGINS` is set by `vmg.sh` to the block's portal origin; the repo `.env.example` default (`http://localhost:*`) behaves differently.
- Pending previews need `CDN_PREVIEW_SECRET`; `vmg.sh` generates a random one per process start, so tokens don't survive `stop-web`.
