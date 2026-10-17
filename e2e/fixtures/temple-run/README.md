# Temple Dash — e2e fixture (E2E-1)

A three-lane, temple-run style endless runner used by `e2e/temple-run.spec.mjs` to drive the real
creator path: `/upload` form post → validation → `/play/<slug>` → the shared player's fullscreen button.

`index.html` is the artifact the spec uploads: one self-contained UTF-8 HTML file (~142 KB) with every
sprite and sound inlined as a `data:` URL, no external scripts, styles, fonts or fetches. That is what
the Meshground runtime contract asks for — and it is also the only thing that *works*: the game CDN
serves the document from `/g/<id>/index.html` with a CSP whose `img-src`/`media-src` allow `data:`,
`blob:` and the library CDNs but **not** the CDN's own origin, so a game cannot load sibling asset
files (see "Known platform gap" below).

## Play it

Open `index.html` in any browser, or upload it to a local Meshground stack.

- **Lanes:** ← / → (or `A`/`D`), or swipe left/right
- **Jump a stone block:** ↑ / `W` / `Space`, swipe up, or tap
- **Slide under a hanging bar:** ↓ / `S`, or swipe down
- **Restart:** `R` / `Enter`, or tap after a crash

Speed rises the whole run. Score = metres + 25 per gold. The best score is kept in `localStorage`
(`templeDash.best`), which Meshground persists for signed-in players.

## Runtime contract hooks used

| Hook | Where |
| --- | --- |
| `Meshground.declare({ inputSupport: 'both' })` + `<meta name="meshground:input-support">` | both touch and keyboard controls are implemented |
| `Meshground.ready()` | once, right after the first drawn frame |
| `Meshground.gameOver(score)` | on every crash |
| `Meshground.onPause` / `onResume` | stops input and mutes sound effects during ad breaks |

`requestAnimationFrame` + `performance.now()` drive the loop, audio starts only on the first user
input, and every Meshground call is guarded so the file still runs standalone.

## Building

```sh
node e2e/fixtures/temple-run/tools/make-assets.mjs   # (re)draw sprites + synthesize audio
node e2e/fixtures/temple-run/tools/build.mjs          # src/game.html + assets/** -> index.html
node e2e/fixtures/temple-run/tools/build.mjs --check  # fail if index.html is stale
```

Both scripts use only Node builtins (`zlib` for the PNG encoder) and are deterministic: re-running
them produces byte-identical output. `build.mjs` refuses any asset ≥ 100 KB or a game over 4 MB.

## Files and licenses

Everything here is **self-made for this repository** and published under the repository's license.
No third-party or CC0 downloads are included; nothing is fetched at build or run time.

| File | Bytes | What it is | License |
| --- | --- | --- | --- |
| `index.html` | 145217 | built single-file game (assets inlined as `data:` URLs) | self-made (this repo) |
| `src/game.html` | — | game source, with the `/*__MG_ASSETS__*/` asset placeholder | self-made (this repo) |
| `tools/make-assets.mjs` | — | draws every sprite, synthesizes every sound | self-made (this repo) |
| `tools/build.mjs` | — | inlines `assets/**` into `index.html` | self-made (this repo) |
| `thumb.png` | 6731 | 640×360 upload thumbnail, drawn by `make-assets.mjs` | self-made (this repo) |
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

Sizes are the committed bytes; every asset is well under 100 KB, the whole folder is far under 4 MB,
and there are far fewer than 200 files. Types are limited to PNG images, WAV audio, HTML, Markdown and
the two `.mjs` build scripts that live inside this game folder.

## Test hook

The game exposes a read-only `window.templeRun` status object (`assets`, `audio`, `state`, `frames`,
`score`, `gold`, `lane`, `airborne`, `sliding`, `speed`) so `e2e/temple-run.spec.mjs` can assert that
every sprite decoded, the music loop is playing, and the controls moved the runner — without reaching
into the game's internals. It is the fixture's test contract, not part of the Meshground SDK.

## Known platform gap (not fixed here, see /tmp/e2e1-bugs.md)

Uploaded games get a `game_assets` manifest and the CDN can serve versioned files from
`/g/<id>/<version>/<path>`, but the portal always frames `/g/<id>/index.html`, whose CSP has no
own-asset source and whose relative paths resolve one directory above the versioned folder. So
separate asset files cannot be loaded by an uploaded game today. Inlining is the working path, and it
also keeps this fixture at zero missing-asset warnings.
