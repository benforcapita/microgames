# Meshgrounds

Meshgrounds is an open exchange for single-file browser games (Three.js, Canvas, WebGL, etc.). It is built with Astro 7 SSR (`@astrojs/node`) and Node's built-in `node:sqlite`.

The platform architecture separates the main portal from a dedicated, cookieless game CDN. User-submitted game bundles are served from a distinct origin inside sandboxed iframes (`sandbox="allow-scripts allow-pointer-lock"`) with strict Content Security Policies (CSP), preventing game code from accessing portal cookies, authentication, local storage, or DOM.

---

## Requirements

- **Node.js**: `>= 22.13` (Node 22 is required for built-in `node:sqlite`)
- Version management: `.nvmrc` is included (run `nvm use` to select Node 22)

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

---

## Development

Start both the web portal and the game CDN simultaneously:

```bash
npm run dev
```

This launches:
- **Web Portal**: http://localhost:4321
- **Game CDN**: http://localhost:4322

### Individual Services

You can also run the portal and CDN independently:
- `npm run dev:web` — runs only the Astro portal development server.
- `npm run cdn` — runs only the standalone game CDN server (`scripts/game-cdn.mjs`).

---

## Build, Start & Preview

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

## Resetting Local Data

To wipe the local database and reset game files:
1. Stop the running server (`Ctrl+C`).
2. Delete the `data/` directory:
   ```bash
   rm -rf data
   ```
3. Restart the server. On startup, SQLite will re-create `data/meshgrounds.db` and automatically seed initial games and sessions from `seed/`.

---

## Environment Variables

| Name | Purpose |
| --- | --- |
| `MG_WEB_ORIGINS` | Allowed origin(s) of the main portal permitted to frame games (used for the CDN's `frame-ancestors` CSP directive) |
| `MG_CDN_ORIGIN` | Public origin URL of the separate, cookieless game CDN serving uploaded game bundles |
| `MG_CDN_PORT` | Port number for the game CDN HTTP server |
| `MG_DATA_DIR` | Filesystem directory path where the SQLite database and uploaded game bundles are stored |
| `MG_MIN_PLAYS` | Minimum number of plays required before a game can graduate out of the Proving Grounds |
| `PUBLIC_ADSENSE_CLIENT` | Google AdSense H5 Games client ID (if omitted, a mock ad overlay is used) |

---

## Project Layout

```
.
├── cdn/                  # In-game runtime (boot.js) injected into games for telemetry, pausing, and SDK shims
├── public/               # Static assets (favicon.svg) and AI agent integration guide (EXCHANGE_SDK.md)
├── scripts/              # Dev orchestrator (dev.mjs) and standalone cookieless CDN server (game-cdn.mjs)
├── seed/                 # Seed database manifest (games.json) and sample single-file games (games/)
├── src/
│   ├── client/           # Portal-side client scripts for postMessage communication (player.ts) and ads (ads.ts)
│   ├── components/       # Astro UI components (GameCard, GameThumb, MeshArt, Rate)
│   ├── layouts/          # Astro base layout (Layout.astro)
│   ├── lib/              # Client utilities (format.ts) and server logic (db.ts, games.ts, config.ts)
│   ├── pages/            # SSR pages and API routes (portal, play view, upload, proving grounds, ratings, telemetry)
│   └── styles/           # Global styles (global.css)
├── .env.example          # Environment variable template
├── .nvmrc                # Node version specification
├── AGENTS.md             # Repository guidelines and operational notes
├── astro.config.mjs      # Astro configuration (standalone Node adapter, port 4321)
├── package.json          # Project scripts and dependencies
└── tsconfig.json         # TypeScript configuration
```
