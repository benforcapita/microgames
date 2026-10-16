# Meshground

Meshground is an open exchange for single-file browser games (Three.js, Canvas, WebGL, etc.). It is built with Astro 7 SSR (`@astrojs/node`) on Supabase: Postgres (via `postgres.js` + `DATABASE_URL`), Auth (`@supabase/ssr` cookies), and Storage (private `games` bucket).

The platform architecture separates the main portal from a dedicated, cookieless game CDN. User-submitted game bundles are served from a distinct origin inside sandboxed iframes (`sandbox="allow-scripts allow-pointer-lock"`) with strict Content Security Policies (CSP), preventing game code from accessing portal cookies, authentication, local storage, or DOM.

---

## Requirements

- **Node.js**: `>= 22.13` (version management: `.nvmrc` is included; run `nvm use` to select Node 22)
- **Docker**: Required for running the local Supabase stack

---

## Setup

1. Install dependencies:
   ```bash
   npm ci
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```

3. Start the local Supabase stack:
   ```bash
   npm run db:start
   ```
   This launches the local Supabase stack (requires Docker) and automatically applies all migrations from `supabase/migrations/*`.
   Run `npx supabase status` to display service status and obtain the local publishable and secret API keys, then put them (and the local API URL / `DATABASE_URL`, as noted in `.env.example`) into your `.env`.
   Auth emails sent by Supabase during local development are captured by Mailpit and viewable at http://127.0.0.1:54324.

4. Seed demo games (optional):
   ```bash
   npm run seed
   ```
   Loads the sample games into the local database and Storage bucket with **no** plays or ratings, so every stat on the site is real. Add `-- --synthetic-plays` to also create fake sessions and ratings for testing graduation locally (never on a project real players see). To replace existing seed games (this also deletes their plays and ratings), pass `-- --force`:
   ```bash
   npm run seed -- --force
   ```

5. Stop the local Supabase stack:
   When finished, stop the local Supabase containers with:
   ```bash
   npm run db:stop
   ```

---

## Migrations

Database schema and migration files live in `supabase/migrations/`.

- When developing locally, all migration files in `supabase/migrations/*` are automatically applied when starting the stack with `npm run db:start`.
- To create a new migration, add a timestamped SQL file in `supabase/migrations/` (for example, `YYYYMMDDHHMMSS_name.sql`).
- Applying migrations to a hosted project is handled by maintainers.

### pg_net lockdown (hosted, required)

Migrations run as `postgres` and cannot change pg_net grants (`supabase_admin` owns them). On pg_net 0.20.4, `anon` and `authenticated` can execute all 12 functions in schema `net` (see the comment in `supabase/migrations/20261015120800_enqueue_validate_game.sql`).

Hosted remediation: Supabase support runs `supabase/ops/pg_net_lockdown.sql` as `supabase_admin`. Then this is a required post-deploy step:

```bash
npm run check:pg-net -- --strict
```

It exits non-zero while any reported row is `GAP`. `net` must stay out of the API exposed schemas (Settings > API / `pgrst.db_schemas`).

---

## Development

Start both the web portal and the game CDN simultaneously:

```bash
npm run dev
```

This launches:
- **Web Portal**: http://localhost:4321
- **Game CDN**: http://localhost:4322

Both services are required for gameplay and testing.

### Individual Services

You can also run the portal and CDN independently:
- `npm run dev:web` — runs only the Astro portal development server (port 4321).
- `npm run cdn` — runs only the standalone game CDN server (`scripts/game-cdn.mjs`, port 4322).

---

## Build, Start & Preview

- **Check**: Run TypeScript and Astro template diagnostics:
  ```bash
  npm run check
  ```
- **Build**: Compile the Astro application for production:
  ```bash
  npm run build
  ```
- **Start**: Launch the production Astro server and game CDN together:
  ```bash
  npm start
  ```
- **Preview**: Preview the Astro production build locally:
  ```bash
  npm run preview
  ```

---

## Environment Variables

| Name | Required | Purpose |
| --- | --- | --- |
| `PUBLIC_SUPABASE_URL` | Required | Base URL for the Supabase API endpoints |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Required | Supabase publishable API key for client-side and authenticated SSR requests |
| `SUPABASE_SECRET_KEY` | Required (server-only) | Supabase secret key for server-side administration and private Storage bucket access (never expose to the browser) |
| `DATABASE_URL` | Required | PostgreSQL connection string used by `postgres.js` for direct database access |
| `SITE_URL` | Optional | Unused by auth email. Sign-up and magic-link redirects come from the request origin (`src/lib/server/email-redirect.ts`) |
| `MG_WEB_ORIGINS` | Optional | Allowed portal origins permitted to embed game frames (used in CDN `frame-ancestors` CSP directive) |
| `MG_CDN_ORIGIN` | Optional | Public origin URL of the dedicated cookieless game CDN serving uploaded game bundles |
| `MG_CDN_PORT` | Optional | Port number for the game CDN HTTP server |
| `CDN_PREVIEW_SECRET` | Optional (portal + CDN) | Shared HMAC secret. The CDN serves `pending`/`rejected` bundles only with a portal-minted token (game id + ≤10 min expiry), and the portal mints one only for the owner's `/play`. If it's unset, those bundles are never served. Never commit it. |
| `MG_MIN_PLAYS` | Optional | Minimum number of plays required before a game can graduate out of the Proving Grounds |
| `PUBLIC_ADSENSE_CLIENT` | Optional | Google AdSense H5 Games client identifier (uses a mock ad overlay if omitted) |

### Edge Function secrets (`validate-game`)

These are set on the Supabase side, with `supabase secrets set` or the dashboard. They are not portal env vars, and must never be logged or committed.

| Name | Required | Purpose |
| --- | --- | --- |
| `VALIDATE_GAME_HOOK_SECRET` | Required for the EF-2 hook | Shared secret that the database hook sends in the `x-meshgrounds-hook` header. It's compared in constant time. If it's unset, header auth is disabled and only a service-role JWT works. It must match the vault secret `validate_game_hook_secret` used by EF-2. |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_JWT_SECRET` | Injected by Supabase | Allow manual reruns with `Authorization: Bearer <service-role JWT>`. Any other caller gets 401. |

---

## Project Layout

```
.
├── cdn/                  # In-game runtime (boot.js) injected into games for telemetry, pausing, and SDK shims
├── public/               # Static assets (favicon.svg) and AI agent integration guide (EXCHANGE_SDK.md)
├── scripts/              # Dev orchestrator (dev.mjs), cookieless CDN server (game-cdn.mjs), seed script (seed.mjs)
├── seed/                 # Seed database manifest (games.json) and sample single-file games (games/)
├── src/
│   ├── client/           # Portal-side client scripts for postMessage communication (player.ts) and ads (ads.ts)
│   ├── components/       # Astro UI components (GameCard, GameThumb, MeshArt, Rate)
│   ├── layouts/          # Astro base layout (Layout.astro)
│   ├── lib/              # Client formatting utilities and server-side modules
│   │   ├── format.ts     # Client and server formatting helpers
│   │   └── server/       # Server-only logic:
│   │       ├── auth.ts       # Authentication utilities and safe redirect guard
│   │       ├── config.ts     # Server configuration and graduation thresholds
│   │       ├── db.ts         # PostgreSQL database connection pool via postgres.js
│   │       ├── games.ts      # Game catalog queries, uploads, and graduation logic
│   │       ├── profiles.ts   # User profile queries and handle validation
│   │       ├── saves.ts      # Cloud save persistence and validation
│   │       └── supabase.ts   # Request-scoped Supabase client and service-role admin client
│   ├── middleware.ts     # Supabase auth session handling, profile resolution, and route protection
│   ├── pages/            # SSR pages and API routes (portal, play view, upload, proving grounds, ratings, telemetry)
│   └── styles/           # Global styles (global.css)
├── supabase/             # Local Supabase configuration and database migrations
│   ├── migrations/       # Timestamped PostgreSQL schema migrations
│   └── config.toml       # Supabase CLI configuration for local services
├── .env.example          # Environment variable template
├── .nvmrc                # Node version specification
├── AGENTS.md             # Repository guidelines and operational notes
├── astro.config.mjs      # Astro configuration (standalone Node adapter, port 4321)
├── package.json          # Project scripts and dependencies
└── tsconfig.json         # TypeScript configuration
```
