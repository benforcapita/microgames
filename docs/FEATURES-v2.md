# Meshgrounds — Features v2 plan

Status: **draft for Ben's review**. Written 2026-10-15 against `main` @ `b64cc90`.
Nothing here is implemented or migrated yet. All migrations below are **proposals**: do not apply until the PR that owns them is reviewed.

Ground rules that apply to every ticket:

- Tables stay **Meshgrounds-only** (`public.*` tables owned by this app). Keep the existing posture from `20261015000000_init.sql` and `…_revoke_api_grants.sql`: **RLS enabled, no policies, `revoke all … from anon, authenticated`**. All access goes through the Astro server (postgres role). Every new table repeats this pattern; the RLS line is part of the acceptance criteria.
- Migrations are additive and backward compatible: deploy the code that reads a new column only after the migration ships.
- Every PR keeps `npm run check`, `npm run build`, and `npm test` green. Proof is listed per ticket.
- Difficulty tags: **easy** (< ½ day, low risk), **regular** (1–2 days), **very-difficult** (multi-day, new infra or security surface).

---

## 1. Sign-up section

### Current state (exists)
- `/login` already has three modes: `password`, `signup` (`/login?mode=signup`), `magic`. `POST /api/auth/login` calls `supabase.auth.signUp` with email confirmation redirect to `/auth/callback`; then `/onboarding` forces a handle (`profiles` row) via middleware.
- **Missing:** there is no visible sign-up entry point or section on the site. The header and homepage only link to "log in" in a few contextual spots. Nothing explains what an account gets you. No OAuth providers. Copy on `/login` says "Playing is always free and needs no account", which contradicts feature 2.

### Behavior spec
- *As a visitor* I see a clear "Sign up" CTA in the header and a sign-up section on the homepage explaining the benefits (unlimited play, ratings, cloud saves, uploading).
- *As a visitor* I can go to `/signup` (alias of `/login?mode=signup`) and create an account with email+password or a magic link, then pick a handle.

Acceptance criteria
- Header shows `Sign up` + `Log in` when logged out; avatar/handle when logged in.
- Homepage has a sign-up section (benefits + CTA) hidden for logged-in users.
- `/signup?next=/play/x` → after confirmation + onboarding the user lands on `/play/x`.
- `/login` copy updated to match the one-free-game rule.
- Existing flows (password login, magic link, onboarding redirect) unchanged (e2e).

### Data / schema
None. (Optional later: Google/GitHub OAuth, which is Supabase dashboard config only.)

### API / pages
- `src/pages/signup.astro` (thin redirect or shared component with `/login`), `Layout.astro` header, `index.astro` section.

### PRs
| # | Title | Tag | Proof |
|---|---|---|---|
| SU-1 | Header Sign up / Log in buttons + `/signup` route | easy | screenshots logged-out/in; `check`+`build` |
| SU-2 | Homepage sign-up section + `/login` copy update | easy | screenshot desktop+mobile |
| SU-3 | e2e: sign-up → onboarding → `next` redirect (local Supabase, email confirm off) | regular | Playwright run log |

---

## 2. One free game, then log in

### Current state
- **Nothing exists.** Anyone can play any game anonymously forever (`/play/[slug]` has no gate). Telemetry sessions are anonymous UUIDs (`sessions` table has no user/visitor column).

### Behavior spec
- *As an anonymous visitor* I can fully play **one** game (unlimited replays/restarts of that same game).
- *When I launch a different game* I get a modal: "Sign up free to keep playing" with Sign up / Log in, and `next` returns me to that game.
- *As a logged-in user* I'm never gated.
- Crawlers / link previews still see game pages (gate is on launch, not on page render), so SEO is unaffected.

Acceptance criteria
- Gate keyed on **"first game played"**, i.e. first `session_start` of a game by this visitor. Same game again = allowed.
- Enforced **server-side** too: the launch flow requests a short-lived play token from `POST /api/play/[slug]/start`; the server checks an httpOnly signed cookie `mg_free` (stores the allowed game id, HMAC with server secret). The CDN does not need changes; the portal only renders the iframe after the token call succeeds. (Honest limitation: clearing cookies / incognito resets it. That's acceptable; it's a conversion nudge, not DRM. Optional IP+UA rate cap noted in open questions.)
- Gate modal is accessible (focus trap, Esc closes), does not count as a crash or session.
- After sign-up the original game id is forgotten; nothing else migrates.
- Metric: `sessions.gated` / new events so we can measure conversion.

### Data / schema (proposal)
```sql
-- 2026xxxx_play_gate.sql
alter table public.sessions add column user_id uuid references auth.users (id) on delete set null;
create table public.gate_events (
  id bigserial primary key,
  game_id text references public.games (id) on delete cascade,
  kind text not null check (kind in ('shown','signup_click','login_click','converted')),
  created_at timestamptz not null default now()
);
alter table public.gate_events enable row level security;
revoke all on table public.gate_events from anon, authenticated;
```
(`sessions.user_id` also unlocks "continue playing" in feature 5.)

### API / pages
- `POST /api/play/[slug]/start` → `{ ok: true }` or `401 { gate: true }`; sets `mg_free` cookie on first allowed play.
- `src/client/player.ts`: call start before mounting iframe; render gate modal on 401.
- `src/lib/server/play-gate.ts` with pure `decideGate(cookie, gameId, user)` + unit tests.

### PRs
| # | Title | Tag | Proof |
|---|---|---|---|
| PG-1 | `play-gate.ts` pure logic + HMAC cookie + unit tests | easy | `npm test` output |
| PG-2 | `POST /api/play/[slug]/start` + player.ts gate + modal | regular | e2e: anon plays A ✓, replays A ✓, opens B → modal; logged-in → no modal |
| PG-3 | Migration `sessions.user_id` + `gate_events` + record user on session_start | regular | migration diff, `supabase db reset` locally, advisor shows no new RLS lint |
| PG-4 | Feature flag `MG_FREE_GAMES` (default 1; 0 = gate off) for safe rollout | easy | env toggle demo |

---

## 3. Game submission pipeline (prompts → static checks → headless run → report → publish)

### Current state
- `/upload` + `POST /api/games` with `validateGameUpload` (`src/lib/server/upload.ts`): title/license/agree checks, `.html` extension, ≤ 5 MB, UTF-8, regex "looks like HTML", optional thumb ≤ 512 KB. Unit tests in `upload.test.ts`.
- On success the game goes **straight** into storage + `games` with `stage='proving'` and is **immediately public** in the Proving Grounds. No runtime validation, no report, no draft state.
- Runtime contract today = `cdn/boot.js` (injected by the CDN): `window.Meshgrounds` v1 (`gameOver`, `levelComplete`, `submitScore`, `requestRewardAd`, `adBreak`, `onPause`, `onResume`, `paused`), automatic rAF/clock/audio pause, localStorage shim persisted via `__MG_STORAGE` (= save), telemetry `__MG_FIRST_FRAME`, `__MG_INPUT`, `__MG_CRASH`. Network allowlist is enforced by the CDN CSP (`connect-src` = jsdelivr, unpkg, esm.sh, cdnjs, jspm only).
- **Missing:** there is **no explicit "ready" hook** in boot.js (first rAF frame is the de-facto ready signal). There is no written contract doc for creators, no prompts, no pending/validation stage, no headless validation, no report UI.

### Runtime contract (to publish as `docs/RUNTIME-CONTRACT.md`, versioned v1)
1. Single self-contained `.html` file, UTF-8, ≤ 5 MB (target ≤ 1 MB). External scripts/styles/fonts only from the allowlist hosts; no other network (`fetch`, XHR, WebSocket, images) — blocked by CSP anyway.
2. No reliance on real `localStorage`/cookies/IndexedDB semantics beyond the shim: use `localStorage` for saves (persisted by the portal); keep it ≤ 100 KB JSON.
3. Drive the loop with `requestAnimationFrame` and `performance.now()` (so automatic pause works); audio via WebAudio/HTMLMediaElement. Optionally listen to `Meshgrounds.onPause/onResume`.
4. **New in v1.1:** call `Meshgrounds.ready()` once the first playable frame is shown (portal receives `__MG_READY`). Call `Meshgrounds.gameOver(score)` / `levelComplete(level, score)` at loop end (feeds completion-rate telemetry).
5. Must render to a `<canvas>` or visible DOM within 3 s, throw no uncaught errors in the first 10 s, work in a sandboxed opaque-origin iframe (`allow-scripts allow-pointer-lock` only: no popups, forms, top navigation, `alert`).
6. Must not use `eval` of remote code, crypto-mining, or try to escape the frame.

### Validation: where it runs and why (decision)
**Two layers, both free:**

1. **Client-side pre-check (instant, advisory):** on the upload page the creator's browser runs the static checks and loads the file in a hidden sandboxed iframe from the *real CDN preview route* for 10 s, collecting boot.js messages. Gives feedback in seconds before submitting. Not trusted (the creator controls the browser).
2. **Authoritative headless run: GitHub Actions** (`.github/workflows/validate-game.yml`, triggered by `workflow_dispatch` from the server with a fine-grained token scoped to *Actions: write on this repo only*). The job installs Playwright Chromium (already a devDependency, already used by `e2e/game.spec.mjs`), opens the game through the real CDN at `/g/<id>/index.html?preview=<signed token>` inside the same parent harness as production, and records: console errors, uncaught exceptions, `__MG_FIRST_FRAME`/`__MG_READY` timing, non-blank canvas/DOM check (pixel variance), CSP violation reports / requests to non-allowlisted hosts (Playwright `page.on('request')`), a screenshot at 3 s and 10 s, and a pause→resume probe. Results are POSTed to `/api/validation/callback` with an HMAC signature; screenshot goes to the private `games` bucket under `<id>/validation/`.

Why GitHub Actions:
- **Free**: the repo is private, so it uses the 2,000 included Actions minutes/month on the Free plan (≈ 1–1.5 min per validation including cached browser ⇒ ~1,300+ submissions/month). If the repo goes public, it's unlimited. Usage can be watched in billing; a daily cap in the dispatcher prevents surprises.
- Real Chromium, same Playwright code path we already have in CI (`npm run e2e`), so no new tech.
- Untrusted game code runs on a throwaway GitHub VM, never on Vercel or the Supabase-connected server, and still only via the sandboxed CDN origin.
- Rejected alternatives: **Vercel Sandbox** is metered (Hobby allowance is small and paid beyond; adds cost risk and a Chromium image to maintain). **Client-side-only** check is spoofable, so it can't gate publishing. **Headless Chromium in a Vercel Function** hits size/time limits and puts untrusted code next to secrets.
- Trade-off: latency ~1–3 min (queue + run). UX handles it with a "Validating…" report page that polls.
- Security notes: the workflow gets **no** Supabase secret; it only gets the preview URL (signed, 30-min TTL) and a callback HMAC secret. `workflow_dispatch` inputs are treated as untrusted (validated id regex, never interpolated into shell).

### Behavior spec
- *As a creator* on `/upload` I see step 1 "Prepare your game with AI": two copyable prompts (A: conform, B: QA checklist) with copy buttons, plus a link to the contract.
- *As a creator* when I submit, my game is saved as **`pending`** (not visible publicly), and I'm taken to `/submissions/[id]` showing static check results immediately, then the headless run status (queued → running → pass/fail).
- The report shows each check with pass/fail/warn, console log excerpt, network requests blocked, timings, screenshot(s).
- **Pass** → "Publish to Proving Grounds" button (stage `pending` → `proving`). **Fail** → reasons + "upload a fixed version" (re-uses the same submission, new version).
- Owner-only access to pending games and reports; the CDN serves pending bundles only with a valid preview token.

Acceptance criteria
- Static checks (server, reuse `upload.ts`): size, UTF-8, has `<script>`/`<canvas>`, no `<script src>` / `<link href>` / `import` to non-allowlisted hosts, no `<iframe>`/`<form action>`/`window.open`/`top.location` patterns (warn), no obvious `fetch('http…')` to non-allowlisted hosts (warn; CSP is the real enforcement).
- Headless: fail if any uncaught error in 10 s, no first frame within 3 s, blank canvas/DOM, request to a non-allowlisted host, or crash event. Warn if `Meshgrounds.ready()` not called (becomes fail after a grace period, see open questions).
- Report visible within 3 min for 95% of runs; timeout at 10 min → status `error` with "retry" button.
- Callback rejects bad HMAC, unknown/mismatched submission, replayed run ids.
- Pending games never appear in `/proving`, `/games`, feeds, creator pages, or the CDN without token.

### Data / schema (proposal)
```sql
-- 2026xxxx_submissions.sql
alter table public.games drop constraint games_stage_check;
alter table public.games add constraint games_stage_check check (stage in ('pending','proving','live','rejected'));

create table public.game_validations (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  version int not null default 1,
  status text not null check (status in ('queued','running','passed','failed','error')),
  static_report jsonb not null default '{}',
  run_report jsonb,              -- checks[], console[], blocked_requests[], timings
  screenshot_paths text[] not null default '{}',
  gh_run_id bigint,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index game_validations_game_idx on public.game_validations (game_id, created_at desc);
alter table public.game_validations enable row level security;
revoke all on table public.game_validations from anon, authenticated;
```
Existing list queries must add `stage <> 'pending' and stage <> 'rejected'` (or explicit stage filters) — covered by PR SP-3.

### API / pages
- `POST /api/games` → creates `pending` game + validation row, runs static checks, dispatches workflow.
- `GET /api/submissions/[id]` (owner) → status JSON for polling. `POST /api/submissions/[id]/publish` (owner, requires `passed`). `POST /api/submissions/[id]/retry`.
- `POST /api/validation/callback` (HMAC) ← GitHub Action.
- CDN `cdn/handler.mjs`: accept `?preview=<token>` (HMAC, TTL) to serve pending bundles.
- `boot.js`: add `Meshgrounds.ready()` → `__MG_READY`.
- Pages: `/upload` (prompts step), `/submissions/[id]` (report), `/me` lists submissions.

### PRs
| # | Title | Tag | Proof |
|---|---|---|---|
| SP-1 | `docs/RUNTIME-CONTRACT.md` + prompts A/B on `/upload` with copy buttons | easy | screenshot; prompt text reviewed by Ben |
| SP-2 | `boot.js`: `Meshgrounds.ready()` + player handles `__MG_READY` (telemetry) | easy | e2e asserts message; backward compatible |
| SP-3 | Migration: `pending`/`rejected` stages + `game_validations`; all list queries exclude pending | regular | local `db reset`; unit test that `listGames` never returns pending; advisors clean |
| SP-4 | Static analyzer `src/lib/server/static-check.ts` (pure) + tests with fixture games | regular | `npm test` with ≥ 10 fixtures (good/bad) |
| SP-5 | Upload → pending + `/submissions/[id]` report page (static results only) + publish button | regular | e2e upload → report → publish → visible in /proving |
| SP-6 | CDN preview token for pending bundles | regular | unit tests: valid/expired/tampered token; prod CSP unchanged |
| SP-7 | `validate-game.yml` workflow + `scripts/validate-game.mjs` (Playwright harness, screenshot, network audit) | very-difficult | workflow run links for 1 passing + 3 failing fixtures (error, blank, network) |
| SP-8 | Dispatcher (server → GH `workflow_dispatch`, daily cap) + HMAC callback + polling UI + screenshots | very-difficult | end-to-end on preview deploy; callback rejects forged HMAC (test) |
| SP-9 | Client-side 10 s iframe pre-check on `/upload` (advisory) | regular | screenshot of instant report; documented as non-authoritative |
| SP-10 | Backfill: run validator over existing proving/live games, report only (no unpublish) | easy | report table in PR |

### Creator prompts (draft — full text)

**Prompt A — make my game Meshgrounds-ready**

```
You are helping me prepare a browser game for Meshgrounds (meshgrounds.vercel.app). Rewrite the game I paste below so it follows the Meshgrounds runtime contract v1 exactly. Keep the gameplay, art and feel the same; only change what's needed.

THE CONTRACT
1. Output ONE self-contained HTML file (UTF-8), starting with <!doctype html>. All game code, CSS, and assets inline (images/audio as data: URIs or generated in code). Total size under 5 MB, ideally under 1 MB.
2. External scripts/styles/fonts are allowed ONLY from: cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io, fonts.googleapis.com, fonts.gstatic.com. Pin exact versions. No other network access at all: no fetch/XHR/WebSocket/analytics/ads/backends, no remote images.
3. The game runs inside a sandboxed iframe (scripts + pointer lock only). Do NOT use: alert/confirm/prompt, window.open, popups, forms that submit, top/parent navigation, real cookies, IndexedDB, service workers, or anything that needs a real origin.
4. Saving: store progress with localStorage only (Meshgrounds persists it for the player). Keep saved data small (under 100 KB of JSON). Wrap reads in try/catch and handle missing data.
5. Game loop: use requestAnimationFrame for rendering and performance.now() for timing (Meshgrounds pauses these automatically during ads). Do not use setInterval/setTimeout for the main loop. Use Web Audio or <audio>, and start audio only after the first user input.
6. Pause: also support Meshgrounds pause events if window.Meshgrounds exists:
     window.Meshgrounds?.onPause(() => { /* stop input, mute */ });
     window.Meshgrounds?.onResume(() => { /* resume */ });
7. Lifecycle hooks (always guard with optional chaining so the file still works outside Meshgrounds):
     window.Meshgrounds?.ready?.();                      // once, when the first playable frame is on screen
     window.Meshgrounds?.levelComplete?.(level, score);  // when a level ends
     window.Meshgrounds?.gameOver?.(score);              // when a run ends
     window.Meshgrounds?.submitScore?.(score);           // optional, for high scores
8. Render something visible (canvas or DOM) within 3 seconds of load, even if it's a title screen. Size the canvas to the window and handle resize; support keyboard AND touch/pointer input.
9. Never throw uncaught errors: guard against nulls, check WebGL availability and show a friendly message if it's missing, handle webglcontextlost.
10. No minified blobs of unknown origin, no eval of downloaded code, no crypto-mining, no attempts to access parent/top.

OUTPUT
- The complete final HTML file in one code block, nothing omitted ("..." is not allowed).
- After it, a short list of the changes you made and any contract rule you could not satisfy and why.

MY GAME:
[paste your game code here]
```

**Prompt B — QA my game against the Meshgrounds contract**

```
You are a strict QA reviewer for Meshgrounds (meshgrounds.vercel.app). Review the single-file HTML game I paste below against the Meshgrounds runtime contract v1. Do not rewrite the game. Read the code carefully and output a checklist.

For EACH item output exactly one line: [PASS], [FAIL] or [WARN], the item name, and a one-sentence reason with the line or snippet that proves it.

CHECKLIST
1. Single file: one HTML document, UTF-8, starts with <!doctype html>, no references to local files.
2. Size: estimate the file size; FAIL if over 5 MB, WARN if over 1 MB.
3. Network allowlist: list every URL/host in the code. FAIL for any host other than cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io, fonts.googleapis.com, fonts.gstatic.com. FAIL for any fetch/XHR/WebSocket/sendBeacon to a server.
4. Sandbox-safe: FAIL for alert/confirm/prompt, window.open, form submission, top/parent navigation, document.cookie reliance, IndexedDB, service workers.
5. Loop & timing: uses requestAnimationFrame + performance.now(); WARN if setInterval/setTimeout drive the main loop.
6. Pause: WARN if it doesn't handle Meshgrounds.onPause/onResume; FAIL if audio starts before user input.
7. Save: uses localStorage only, wrapped in try/catch, small data; WARN otherwise.
8. Ready hook: calls window.Meshgrounds?.ready?.() once after first frame (FAIL if missing).
9. Game events: calls gameOver(score) and/or levelComplete(level, score) at the right moments (WARN if missing).
10. Hooks guarded: every Meshgrounds call uses optional chaining so the game runs standalone.
11. First render: something visible within 3 seconds (title screen counts).
12. Errors: list any code path that could throw uncaught (null access, missing WebGL, failed asset decode). FAIL if likely on load.
13. Input: keyboard and touch/pointer both work; canvas resizes with the window.
14. Safety: no eval of remote code, obfuscated blobs, mining, tracking, or attempts to reach parent/top.

Finish with:
VERDICT: READY or NOT READY
TOP FIXES: up to 5 bullet points, most important first, each with the exact code change.

MY GAME:
[paste your game code here]
```

---

## 4. User ratings

### Current state (mostly exists)
- Table `ratings(game_id, voter text, stars 1–5, created_at, PK(game_id, voter))`.
- `POST /api/games/[slug]/rate`: requires login (401 otherwise), validates integer 1–5, upserts (one per user per game, **editable**), re-evaluates graduation, returns avg + count.
- `Rate.astro` star widget shows your rating, avg + count, "Log in to rate" when logged out. `games.ts` exposes `avgRating`/`ratingCount`; `/games?sort=rated` exists. Ratings feed graduation gate (`minAvgRating 3` once ≥ 10 votes).
- **Missing / weak:**
  - `voter` is free `text`, not a FK to `auth.users` (no cascade on account delete; can't join to profiles).
  - **No anti-abuse**: owners can rate their own game; no requirement to have played; no rate limiting; no account-age rule; brand-new accounts can brigade graduation.
  - No "remove my rating"; no `updated_at`; avg is computed live (fine now, may need a cached aggregate at scale); `sort=rated` ranks a single 5★ above 200 × 4.8★ (no Bayesian smoothing).
  - No cards show stars in lists consistently; no "rate after play" prompt.

### Behavior spec
- Logged-in users only; 1–5 stars; one per user per game; can change or remove it.
- Can rate only after actually playing the game (≥ 1 `started` session with ≥ 30 s, tied to `sessions.user_id` from PG-3) and not their own game.
- Average + count shown on game page and cards; list ranking uses a Bayesian average.
- Prompt "Rate this game?" after a `gameOver`/`levelComplete` or after 3 min of play.

Acceptance criteria
- Own-game rating → 403 "You can't rate your own game." Not-played → 403 "Play it first."
- Rate limit: max 30 rating writes / user / hour (429).
- Accounts < 24 h old: rating is stored but **not counted** toward graduation (`weight=0`), still shown to the user as theirs.
- `DELETE /api/games/[slug]/rate` removes rating; avg/count update.
- Ranking: `bayes = (C*m + sum)/(C + n)` with C = 10, m = global mean.

### Data / schema (proposal)
```sql
-- 2026xxxx_ratings_v2.sql
alter table public.ratings add column user_id uuid references auth.users (id) on delete cascade;
update public.ratings set user_id = voter::uuid where voter ~ '^[0-9a-f-]{36}$';
alter table public.ratings add column updated_at timestamptz not null default now();
alter table public.ratings add column counted boolean not null default true;
-- follow-up PR after code switched to user_id: drop voter, PK (game_id, user_id)
create index ratings_user_idx on public.ratings (user_id);
-- RLS already enabled; grants already revoked (re-assert in migration for safety)
alter table public.ratings enable row level security;
revoke all on table public.ratings from anon, authenticated;
```

### PRs
| # | Title | Tag | Proof |
|---|---|---|---|
| RT-1 | Block self-rating + rate limit + unit tests | easy | tests; curl 403/429 |
| RT-2 | Migration `user_id` FK + `updated_at` + `counted`; code writes both (expand) | regular | local db reset; data backfill count matches |
| RT-3 | "Must have played" rule (depends on PG-3) + new-account weight | regular | e2e: rate before play → 403, after → 200 |
| RT-4 | `DELETE` rating + UI "clear" | easy | e2e |
| RT-5 | Bayesian `sort=rated` + stars on GameCard | easy | unit test of ordering |
| RT-6 | Post-play rate prompt | easy | screenshot |
| RT-7 | Contract: drop `voter`, PK on `(game_id,user_id)` | easy | migration after RT-2 is deployed |

---

## 5. Dynamic game feed

### Current state
- `/games` (live games only): sorts `top` (plays), `rated`, `new` + tag chips; server-rendered, hard `limit 60`, no pagination. `/proving` lists proving games; homepage shows sections. No trending, no personalization, no "continue playing", no infinite scroll, no feed API.

### Behavior spec
- *As anyone* I get a feed at `/` (or `/games`) with tabs: **For you** (default when logged in), **Trending**, **New**, **Top rated**, plus tag filter.
- *As a logged-in user* I see a **Continue playing** row (games with my sessions/saves in the last 30 days, most recent first) at the top.
- Infinite scroll with keyset pagination (no offset), SSR first page for SEO, then `GET /api/feed`.
- Proving Grounds games are mixed into **New** and (15% of slots) into **For you**, labelled, so they get plays.

Ranking definitions
- **Trending**: `score = plays_7d_weighted / (age_hours + 2)^1.5` with plays counted only if `started` (anti-bot); recomputed every 15 min.
- **Top rated**: Bayesian avg (RT-5).
- **For you**: weighted mix of tag affinity (tags of games the user played/rated ≥ 4) × trending, excluding games played in the last 24 h and own games; anonymous → Trending.
- **Continue playing**: from `sessions.user_id` + `saves.updated_at`.

Acceptance criteria
- `GET /api/feed?tab=trending&cursor=…&tag=…` returns ≤ 24 items + `nextCursor`; stable ordering (no dupes/skips across pages) — tested.
- p95 < 300 ms on 10k games (indexes + materialized trending score).
- Pending/rejected games never appear. Deleted games drop out.
- Works without JS (first page + "More" link).

### Data / schema (proposal)
```sql
-- 2026xxxx_feed.sql
create index sessions_game_created_idx on public.sessions (game_id, created_at desc) where started;
create index sessions_user_idx on public.sessions (user_id, created_at desc) where user_id is not null;
create table public.game_scores (
  game_id text primary key references public.games (id) on delete cascade,
  trending double precision not null default 0,
  bayes_rating double precision,
  plays_7d int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.game_scores enable row level security;
revoke all on table public.game_scores from anon, authenticated;
```
Refresh: a free **Vercel Cron** (Hobby allows daily; for 15-min refresh use `pg_cron` in Supabase, which is free and keeps it in-DB) calling a SQL function `refresh_game_scores()` (security definer, owned by postgres, `revoke execute from public, anon, authenticated`).

### PRs
| # | Title | Tag | Proof |
|---|---|---|---|
| FD-1 | `GET /api/feed` with keyset pagination for New/Top rated + tests | regular | test for no dupes across pages |
| FD-2 | Feed UI tabs + infinite scroll (IntersectionObserver) + no-JS "More" | regular | screen recording / screenshots |
| FD-3 | `game_scores` + `refresh_game_scores()` + pg_cron schedule; Trending tab | very-difficult | EXPLAIN plans; seeded-data ordering test |
| FD-4 | Continue playing row (needs PG-3) | easy | e2e: play → appears in row |
| FD-5 | For you (tag affinity) + proving mix-in | regular | unit tests for scoring function |

---

## Suggested order
SU-1, SU-2 → PG-1..PG-4 → RT-1, RT-4, RT-5 → SP-1, SP-2, SP-3, SP-4, SP-5, SP-6 → SP-7, SP-8 → FD-1, FD-2 → RT-2, RT-3 → FD-3, FD-4, FD-5 → SP-9, SP-10, RT-6, RT-7.

## Open questions for Ben
1. **Free game gate strictness**: is a cookie-based "1 free game" (resets in incognito) good enough, or do you want IP-based limiting too (more friction, shared-IP false positives)? Should **live** and **proving** games both count?
2. **Existing games & the ready hook**: should `Meshgrounds.ready()` be required (fail) for new submissions from day one, or a warning for a grace period? And do current proving/live games get grandfathered?
3. **Validation runner budget**: OK to run it as a GitHub Action on this private repo (≈ 2,000 free min/month, ~1,300 validations), with a daily cap? Or make the repo (or a separate small validator repo) public for unlimited free minutes?
4. **Publishing after pass**: auto-publish to Proving Grounds on pass, or always require the creator to click Publish (current spec)? Any human moderation step?
5. **Rating rule "must have played"**: OK to require a real play (≥ 30 s) before rating, and to not count ratings from accounts under 24 h toward graduation?
