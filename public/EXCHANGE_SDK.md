# Meshground Exchange SDK — integration rules for AI coding agents

You are integrating a single-file HTML/JS (e.g. Three.js) game with the Meshground portal.
The game runs in a sandboxed iframe. Talk to the portal ONLY via `window.parent.postMessage`. Never load an SDK script.

## Rules
1. Keep the game a single self-contained `.html` file. Load libraries only from cdn.jsdelivr.net, unpkg.com, esm.sh, cdnjs.cloudflare.com or ga.jspm.io. No other network calls.
2. When a run ends (player dies / loses), send: `window.parent.postMessage({ type: 'GAME_OVER', score }, '*')`.
3. When a level/loop is cleared, send: `window.parent.postMessage({ type: 'LEVEL_COMPLETE', level, score }, '*')`.
4. Offer ONE optional rewarded ad on the game-over screen (e.g. a "Revive" or "2x coins" button). On click send `{ type: 'REQUEST_REWARD_AD' }`, then wait for a message from `window.parent`:
   - `REWARD_GRANTED` → give the reward.
   - `REWARD_DENIED` → do nothing, keep the game-over screen.
   Grant rewards ONLY on `REWARD_GRANTED`. Never auto-trigger rewarded ads.
5. Between levels (never before the player's first level), you MAY send `{ type: 'REQUEST_AD_BREAK' }` and wait for `AD_BREAK_DONE` before continuing.
6. The portal pauses the game automatically during ads, while the tab is hidden, and while the game is scrolled off-screen (requestAnimationFrame, `performance.now()`, WebAudio and media are frozen). `window.devicePixelRatio` is capped at 2 inside the game, so `renderer.setPixelRatio(devicePixelRatio)` is safe on 3x phones. Use `requestAnimationFrame` for the game loop and `performance.now()` / `THREE.Clock` for time. Clamp frame delta to ≤ 0.1s.
7. `localStorage` works and is persisted by the portal. Use it for high scores and saves.
8. Show a visible "click / tap to start" state, and support keyboard and touch input. Call `event.preventDefault()` on touch to stop double-tap zoom.
9. Render the first frame within 3 seconds. Create geometry procedurally and avoid large inline assets.
10. When the first playable frame is on screen, call `window.Meshground?.ready?.()` once. The portal records `__MG_READY` as ready telemetry. Games that never call it still report the automatic first animation frame. The upload page previews your file and sets `window.__MG_PREVIEW = true` before the Meshground runtime so it can capture a thumbnail from the canvas. Live plays do not set that flag, do not capture, and do not change WebGL context attributes. If you create a WebGL context yourself, pass `{ preserveDrawingBuffer: true }` so that upload preview can read the frame. Meshground sets the same flag itself only when `window.__MG_PREVIEW` is true. A tainted or blank canvas cannot be captured; the creator must upload a thumbnail instead.

## Listening snippet
```js
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  if (e.data?.type === 'REWARD_GRANTED') revivePlayer();
});
```

Optional helpers (available when running on Meshground): `window.Meshground?.ready?.()` once the first playable frame is showing, and `await window.Meshground?.requestRewardAd()` which resolves `true`/`false`.
Games written before the rename keep working: `window.Meshgrounds` is an alias of `window.Meshground`, the `meshgrounds:input-support` meta tag and `meshgrounds:pause` / `meshgrounds:resume` events are still supported. New games should use the `Meshground` names.

## Publishing
If you have the Meshground MCP tools (`publish_game`, `list_my_games`, `update_game`), publish the finished file with `publish_game`. First confirm the license and the content rules with the user. Then use `list_my_games` with the game id to read the validation checks, and fix failures with `update_game`. Otherwise the creator uploads the `.html` on their dashboard.
