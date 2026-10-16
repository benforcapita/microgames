# Upload a submission

A signed-in creator uploads a single-file HTML game with a thumbnail, lands on their owner-only submission page with stage `Pending`, can preview it through a short-lived preview token, and the game later moves to `Proving Grounds` (validated) and `Live` (graduated).

## Sub-features

- `upload-guard` `/upload` 302s to `/login` when signed out.
- `upload-form` `/upload` form: `game` (html), `title`, `license`, `thumb` (or `Use this preview` canvas capture), `agree`, `Submit for validation`.
- `upload-pending` POST `/api/games` 303s to `/submissions/<id>`; badge `Pending`; `/api/submissions/<id>` returns `game.stage = "pending"`.
- `upload-preview` owner preview of pending bundles via a `pt=` token on the CDN (needs `CDN_PREVIEW_SECRET`, set by `vmg.sh`).
- `upload-proving` validation moves `pending → proving` (or `rejected`); proving is playable by direct link only.
- `upload-live` graduation to `live` after `MG_MIN_PLAYS` real plays.
- `upload-delete` POST `/api/games/<id>/delete` 303s to `/me?deleted=1`; submission page then 404s.

## How to get to it (user POV)

- Header button `Upload a game` (→ `/upload`, login first).
- `Fork` on a game page (→ `/upload?fork=<slug>`, title prefilled `… Remix`).
- `/me` lists the creator's submissions with their stage.

## Driving it with vmg.sh

Preconditions:

- `$V up && $V web`, doctor OK; a fresh account (sign up via `/login?mode=signup`, then pick a handle on `/onboarding`).

- **Sign up + handle (curl).** `J=$(mktemp); W=http://127.0.0.1:55668; E=vmg-$VMG_RUN_ID@example.test`; `curl -s -c $J -b $J -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $W" -F mode=signup -F email=$E -F password=vmg-pass-123 -F next=/ $W/api/auth/login` → `303 …/onboarding`; `curl -s -c $J -b $J -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $W" -F handle=vmg$RANDOM -F next=/me $W/api/profile` → `303 …/me`.
- **Upload.** `curl -s -c $J -b $J -D - -o /dev/null -H "Origin: $W" -F title="VMG Game" -F license=MIT -F agree=on -F game=@g.html\;type=text/html -F thumb=@t.png\;type=image/png $W/api/games | grep -i location` → `/submissions/<id>` (a minimal canvas page and any valid PNG work; smoke uses a 1×1 PNG).
- **Pending state.** `curl -s -b $J $W/api/submissions/<id>` → `"stage":"pending"`; `$V shot` is unauthenticated, so for a screenshot use a Playwright context that signs in through the `/login` form, then open `/submissions/<id>` and capture the `Pending` badge.
- **Side effect.** `$V exec -- node --input-type=module -e 'import pg from "postgres";const s=pg(process.env.DATABASE_URL,{max:1});console.log(await s`select id,stage from public.games where title=${"VMG Game"}`);await s.end()'`.
- **Browser form + preview capture.** `$V stop-web && $V exec -- npx playwright test e2e/upload.spec.mjs` (2D/WebGL `Use this preview`, timeout when nothing draws).
- **Proving/live visibility.** `$V exec -- npx playwright test e2e/unlisted-proving.spec.mjs`.
- **Delete.** `curl -s -b $J -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $W" -X POST $W/api/games/<id>/delete` → `303 …/me?deleted=1`.

## Gotchas

- `pending → proving/rejected` is done by the `validate-game` edge function triggered through pg_net. `vmg.sh up` (like `npm run db:start`) excludes `edge-runtime`, so a fresh upload stays `pending` locally. Report `upload-proving` as unverified for a fresh upload; the e2e spec and `supabase/tests/*` cover the DB side by inserting state directly, which is not the user path.
- `upload-live` needs `MG_MIN_PLAYS` (default 100) real plays; `npm run seed -- --synthetic-plays` fakes them and is for local graduation testing only — say so if you use it.
- Uploads require a thumbnail (TH-1) and the `agree` checkbox; missing either is a 4xx/redirect with `error=`, not a bug.
- `/submissions/<id>` is owner-only (SP-5); another account gets 404.
