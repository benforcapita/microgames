# Temple Dash (multi-file) — e2e fixture (UP-1)

The same three-lane endless runner as `e2e/fixtures/temple-run`, but with sprites and audio kept as
**separate files** — nothing is inlined as a `data:` URL. `e2e/temple-run-multi.spec.mjs` drives the
full creator path for a multi-file game: `/upload` form post → the Files page (`/games/<slug>/assets`,
"Add file" form) → validation → `/play/<slug>`, then asserts every asset loads over HTTP from the
game's own versioned folder on the CDN.

`index.html` is the upload artifact (~22 KB). Its `ASSETS` table maps each path to itself
(`"sprites/coin.png": "sprites/coin.png"`), so the browser resolves every file relative to the
document's versioned URL `/g/<id>/<version>/index.html` — e.g. `sprites/coin.png` becomes
`/g/<id>/<version>/sprites/coin.png`. That is exactly where the portal's asset upload stores the
bytes and where the CDN serves them, and the game document's CSP allows only that one folder as an
origin (`img-src`/`media-src`/`connect-src` get `https://<cdn>/g/<id>/<version>/`).

## Play it

Serve the folder over HTTP (e.g. `npx http-server e2e/fixtures/temple-run-multi`) — plain `file://`
works for images but not the audio `fetch`. Or upload `index.html` to a local Meshground stack and
add the twelve files under `assets/` on the game's Files page.

Controls, scoring, runtime-contract hooks and the `window.templeRun` status object are identical to
the single-file fixture — see `../temple-run/README.md`.

## Building

```sh
node e2e/fixtures/temple-run-multi/tools/make-assets.mjs   # regenerate assets/** + thumb.png
node e2e/fixtures/temple-run-multi/tools/build.mjs          # src/game.html + asset list -> index.html
node e2e/fixtures/temple-run-multi/tools/build.mjs --check  # fail if index.html is stale
```

`tools/make-assets.mjs` is a thin wrapper: it runs `../temple-run/tools/make-assets.mjs --out <here>`,
so one generator produces both fixtures' bytes (deterministic, Node builtins only). `build.mjs`
refuses any asset ≥ 100 KB or a game over 4 MB.

## Files and licenses

Everything here is **self-made for this repository** and published under the repository's license.
No third-party or CC0 downloads are included; nothing is fetched at build or run time. The pixel
maps and oscillators live in `../temple-run/tools/make-assets.mjs` (shared generator, `--out` flag);
the bytes produced are identical to the temple-run fixture's.

| File | Bytes | What it is | License |
| --- | --- | --- | --- |
| `index.html` | 22745 | built game document (asset paths only, nothing inlined) | self-made (this repo) |
| `src/game.html` | — | game source, with the `/*__MG_ASSETS__*/` asset placeholder | self-made (this repo) |
| `tools/make-assets.mjs` | — | wrapper around the shared temple-run generator | self-made (this repo) |
| `tools/build.mjs` | — | writes the `ASSETS` path table into `index.html` | self-made (this repo) |
| `thumb.png` | 6731 | 640×360 upload thumbnail, drawn by the shared generator | self-made (this repo) |
| `assets/sprites/runner-run-a.png` | 282 | runner, stride A (48×60) | self-made (this repo) |
| `assets/sprites/runner-run-b.png` | 280 | runner, stride B (48×60) | self-made (this repo) |
| `assets/sprites/runner-jump.png` | 294 | runner, jumping (48×60) | self-made (this repo) |
| `assets/sprites/runner-slide.png` | 225 | runner, sliding (60×36) | self-made (this repo) |
| `assets/sprites/obstacle-block.png` | 211 | stone block to jump (64×64) | self-made (this repo) |
| `assets/sprites/obstacle-bar.png` | 193 | hanging bar to slide under (72×24) | self-made (this repo) |
| `assets/sprites/coin.png` | 171 | gold coin (36×36) | self-made (this repo) |
| `assets/sprites/tile-stone.png` | 205 | floor/wall stone tile (64×64) | self-made (this repo) |
| `assets/audio/music-loop.wav` | 80226 | 4-bar chiptune loop, 11 025 Hz mono (square lead, triangle bass, noise percussion) | self-made (this repo) |
| `assets/audio/sfx-coin.wav` | 2911 | gold pickup blip | self-made (this repo) |
| `assets/audio/sfx-jump.wav` | 2470 | jump / slide chirp | self-made (this repo) |
| `assets/audio/sfx-hit.wav` | 4675 | crash thud | self-made (this repo) |

Every asset is well under the 100 KB per-file warning threshold; the whole game (document plus
twelve files) is far under the 4 MB cap, and only allowlisted types (PNG, WAV, HTML, Markdown,
`.mjs` build scripts) are used.
