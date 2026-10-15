# Meshgrounds runtime contract (v1)

Rules every game uploaded to Meshgrounds must follow. Source: `docs/FEATURES-v2.md` §3 "Runtime contract".

1. Single self-contained `.html` file, UTF-8, ≤ 5 MB (target ≤ 1 MB). External scripts/styles/fonts only from the hosts the game CDN's CSP allows: scripts, styles and fonts from cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only); no other network (`fetch`, XHR, WebSocket, images) — blocked by CSP anyway.
2. No reliance on real `localStorage`/cookies/IndexedDB semantics beyond the shim: use `localStorage` for saves (persisted by the portal); keep it ≤ 100 KB JSON.
3. Drive the loop with `requestAnimationFrame` and `performance.now()` (so automatic pause works); audio via WebAudio/HTMLMediaElement. Optionally listen to `Meshgrounds.onPause/onResume`.
4. **Recommended (a warning, not required, in v1):** call `Meshgrounds.ready()` once the first playable frame is shown (portal receives `__MG_READY`). Call `Meshgrounds.gameOver(score)` / `levelComplete(level, score)` at loop end (feeds completion-rate telemetry).
5. Must render to a `<canvas>` or visible DOM within 3 s, throw no uncaught errors in the first 10 s, work in a sandboxed opaque-origin iframe (`allow-scripts allow-pointer-lock` only: no popups, forms, top navigation, `alert`).
6. Must not use `eval` of remote code, crypto-mining, or try to escape the frame.

## Creator prompts

Paste one of these into your AI coding tool together with your game. They are also on the [/upload](/upload) page with copy buttons.

### Prompt A — make my game Meshgrounds-ready

```
You are helping me prepare a browser game for Meshgrounds (meshgrounds.vercel.app). Rewrite the game I paste below so it follows the Meshgrounds runtime contract v1 exactly. Keep the gameplay, art and feel the same; only change what's needed.

THE CONTRACT
1. Output ONE self-contained HTML file (UTF-8), starting with <!doctype html>. All game code, CSS, and assets inline (images/audio as data: URIs or generated in code). Total size under 5 MB, ideally under 1 MB.
2. External scripts/styles/fonts are allowed ONLY from: cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only). Pin exact versions. No other network access at all: no fetch/XHR/WebSocket/analytics/ads/backends, no remote images.
3. The game runs inside a sandboxed iframe (scripts + pointer lock only). Do NOT use: alert/confirm/prompt, window.open, popups, forms that submit, top/parent navigation, real cookies, IndexedDB, service workers, or anything that needs a real origin.
4. Saving: store progress with localStorage only (Meshgrounds persists it for the player). Keep saved data small (under 100 KB of JSON). Wrap reads in try/catch and handle missing data.
5. Game loop: use requestAnimationFrame for rendering and performance.now() for timing (Meshgrounds pauses these automatically during ads). Do not use setInterval/setTimeout for the main loop. Use Web Audio or <audio>, and start audio only after the first user input.
6. Pause: also support Meshgrounds pause events if window.Meshgrounds exists:
     window.Meshgrounds?.onPause(() => { /* stop input, mute */ });
     window.Meshgrounds?.onResume(() => { /* resume */ });
7. Lifecycle hooks (always guard with optional chaining so the file still works outside Meshgrounds):
     window.Meshgrounds?.ready?.();                      // once, when the first playable frame is on screen (recommended; a warning, not required, in v1)
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

### Prompt B — QA my game against the Meshgrounds contract

```
You are a strict QA reviewer for Meshgrounds (meshgrounds.vercel.app). Review the single-file HTML game I paste below against the Meshgrounds runtime contract v1. Do not rewrite the game. Read the code carefully and output a checklist.

For EACH item output exactly one line: [PASS], [FAIL] or [WARN], the item name, and a one-sentence reason with the line or snippet that proves it.

CHECKLIST
1. Single file: one HTML document, UTF-8, starts with <!doctype html>, no references to local files.
2. Size: estimate the file size; FAIL if over 5 MB, WARN if over 1 MB.
3. Network allowlist: list every URL/host in the code. FAIL for any host other than cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only) — FAIL if those two are used for anything else. FAIL for any fetch/XHR/WebSocket/sendBeacon to a server.
4. Sandbox-safe: FAIL for alert/confirm/prompt, window.open, form submission, top/parent navigation, document.cookie reliance, IndexedDB, service workers.
5. Loop & timing: uses requestAnimationFrame + performance.now(); WARN if setInterval/setTimeout drive the main loop.
6. Pause: WARN if it doesn't handle Meshgrounds.onPause/onResume; FAIL if audio starts before user input.
7. Save: uses localStorage only, wrapped in try/catch, small data; WARN otherwise.
8. Ready hook: calls window.Meshgrounds?.ready?.() once after first frame (WARN if missing; not required in v1).
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
