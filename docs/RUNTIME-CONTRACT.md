# Meshground runtime contract (v1)

Rules every game uploaded to Meshground must follow. Source: `docs/FEATURES-v2.md` §3 "Runtime contract".

1. Single self-contained `.html` file, UTF-8. Whole game, code plus assets, under 4 MB (target ≤ 1 MB); assets over 100 KB get a warning. External scripts/styles/fonts only from the hosts the game CDN's CSP allows: scripts, styles and fonts from cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only); no other network (`fetch`, XHR, WebSocket, images) — blocked by CSP anyway.
2. No reliance on real `localStorage`/cookies/IndexedDB semantics beyond the shim: use `localStorage` for saves (persisted by the portal); keep it ≤ 100 KB JSON.
3. Drive the loop with `requestAnimationFrame` and `performance.now()` (so automatic pause works); audio via WebAudio/HTMLMediaElement. Optionally listen to `Meshground.onPause/onResume`. The portal pauses during ads, while the tab is hidden, and while the game is scrolled off-screen. Inside the game `window.devicePixelRatio` reports at most 2.
4. **Recommended (a warning, not required, in v1):** call `Meshground.ready()` once the first playable frame is shown (portal receives `__MG_READY`). Call `Meshground.gameOver(score)` / `levelComplete(level, score)` at loop end (feeds completion-rate telemetry).
5. Must render to a `<canvas>` or visible DOM within 3 s, throw no uncaught errors in the first 10 s, work in a sandboxed opaque-origin iframe (`allow-scripts allow-pointer-lock` only: no popups, forms, top navigation, `alert`).
6. Must not use `eval` of remote code, crypto-mining, or try to escape the frame.
7. Declare `inputSupport` — `'mobile'`, `'desktop'` or `'both'` (stored by the portal as `input_support`). Preferred: call `window.Meshground?.declare?.({ inputSupport: 'both' })`; alternative: `<meta name="meshground:input-support" content="both">` in the `<head>`. If both are present, `declare()` wins; invalid values are ignored; an undeclared game is treated as `unknown`. Games that support mobile must use touch controls on mobile; games that support desktop must use keyboard/mouse on desktop.

Pre-rebrand names stay supported: `window.Meshgrounds` is an alias of `window.Meshground`, and the `meshgrounds:input-support` meta tag and `meshgrounds:pause` / `meshgrounds:resume` events still work.

The game CDN's CSP is the outer safety limit; this contract may be stricter than what the CSP technically allows (for example, no `fetch` and no remote images).

## Creator prompts

Paste one of these into your AI coding tool together with your game. They are also on the [/upload](/upload) page with copy buttons.

### Prompt A — make my game Meshground-ready

```
You are helping me prepare a browser game for Meshground (meshground.app). Rewrite the game I paste below so it follows the Meshground runtime contract v1 exactly. Keep the gameplay, art and feel the same; only change what's needed.

THE CONTRACT
1. Output ONE self-contained HTML file (UTF-8), starting with <!doctype html>. Whole game, code plus assets, under 4 MB (target ≤ 1 MB); assets over 100 KB get a warning.
2. External scripts/styles/fonts are allowed ONLY from: cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only). Pin exact versions. No other network access at all: no fetch/XHR/WebSocket/analytics/ads/backends, no remote images.
3. The game runs inside a sandboxed iframe (scripts + pointer lock only). Do NOT use: alert/confirm/prompt, window.open, popups, forms that submit, top/parent navigation, real cookies, IndexedDB, service workers, or anything that needs a real origin.
4. Saving: store progress with localStorage only (Meshground persists it for the player). Keep saved data small (under 100 KB of JSON). Wrap reads in try/catch and handle missing data.
5. Game loop: use requestAnimationFrame for rendering and performance.now() for timing (Meshground pauses these automatically during ads). Do not use setInterval/setTimeout for the main loop. Use Web Audio or <audio>, and start audio only after the first user input.
6. Pause: also support Meshground pause events if window.Meshground exists:
     window.Meshground?.onPause(() => { /* stop input, mute */ });
     window.Meshground?.onResume(() => { /* resume */ });
7. Lifecycle hooks (always guard with optional chaining so the file still works outside Meshground):
     window.Meshground?.ready?.();                      // once, when the first playable frame is on screen (recommended; a warning, not required, in v1)
     window.Meshground?.levelComplete?.(level, score);  // when a level ends
     window.Meshground?.gameOver?.(score);              // when a run ends
     window.Meshground?.submitScore?.(score);           // optional, for high scores
8. Render something visible (canvas or DOM) within 3 seconds of load, even if it's a title screen. Size the canvas to the window and handle resize. Use touch controls on mobile and keyboard/mouse on desktop, matching the inputSupport you declare (rule 11).
9. Never throw uncaught errors: guard against nulls, check WebGL availability and show a friendly message if it's missing, handle webglcontextlost.
10. No minified blobs of unknown origin, no eval of downloaded code, no crypto-mining, no attempts to access parent/top.
11. Declare which devices the game supports, matching the controls you actually implemented: 'mobile', 'desktop' or 'both'. Preferred: window.Meshground?.declare?.({ inputSupport: 'both' }); alternative: <meta name="meshground:input-support" content="both"> in <head>. If you use both, declare() wins; undeclared games show as "unknown".

OUTPUT
- The complete final HTML file in one code block, nothing omitted ("..." is not allowed).
- After it, a short list of the changes you made and any contract rule you could not satisfy and why.

MY GAME:
[paste your game code here]
```

### Prompt B — QA my game against the Meshground contract

```
You are a strict QA reviewer for Meshground (meshground.app). Review the single-file HTML game I paste below against the Meshground runtime contract v1. Do not rewrite the game. Read the code carefully and output a checklist.

For EACH item output exactly one line: [PASS], [FAIL] or [WARN], the item name, and a one-sentence reason with the line or snippet that proves it.

CHECKLIST
1. Single file: one HTML document, UTF-8, starts with <!doctype html>.
2. Size: whole game, code plus assets, under 4 MB (target ≤ 1 MB); assets over 100 KB get a warning. FAIL if over that limit, WARN if any asset is over 100 KB, WARN if over 1 MB.
3. Network allowlist: list every URL/host in the code. FAIL for any host other than cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com, ga.jspm.io; plus fonts.googleapis.com (stylesheets only) and fonts.gstatic.com (font files only) — FAIL if those two are used for anything else. FAIL for any fetch/XHR/WebSocket/sendBeacon to a server.
4. Sandbox-safe: FAIL for alert/confirm/prompt, window.open, form submission, top/parent navigation, document.cookie reliance, IndexedDB, service workers.
5. Loop & timing: uses requestAnimationFrame + performance.now(); WARN if setInterval/setTimeout drive the main loop.
6. Pause: WARN if it doesn't handle Meshground.onPause/onResume; FAIL if audio starts before user input.
7. Save: uses localStorage only, wrapped in try/catch, small data; WARN otherwise.
8. Ready hook: calls window.Meshground?.ready?.() once after first frame (WARN if missing; not required in v1).
9. Game events: calls gameOver(score) and/or levelComplete(level, score) at the right moments (WARN if missing).
10. Hooks guarded: every Meshground call uses optional chaining so the game runs standalone.
11. First render: something visible within 3 seconds (title screen counts).
12. Errors: list any code path that could throw uncaught (null access, missing WebGL, failed asset decode). FAIL if likely on load.
13. Input: touch controls work on mobile and keyboard/mouse on desktop, for every platform the game declares; canvas resizes with the window.
14. Safety: no eval of remote code, obfuscated blobs, mining, tracking, or attempts to reach parent/top.
15. Input support declaration: declares inputSupport via window.Meshground?.declare?.({ inputSupport }) (preferred) or <meta name="meshground:input-support" content="…"> with 'mobile', 'desktop' or 'both' (WARN if missing — the game shows as "unknown"; WARN for any other value; WARN if the declared platforms don't match the controls in item 13).

Finish with:
VERDICT: READY or NOT READY
TOP FIXES: up to 5 bullet points, most important first, each with the exact code change.

MY GAME:
[paste your game code here]
```
