# Meshgrounds Exchange SDK — integration rules for AI coding agents

You are integrating a single-file HTML/JS (e.g. Three.js) game with the Meshgrounds portal.
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
6. The portal pauses the game automatically during ads (requestAnimationFrame, `performance.now()`, WebAudio and media are frozen). Use `requestAnimationFrame` for the game loop and `performance.now()` / `THREE.Clock` for time. Clamp frame delta to ≤ 0.1s.
7. `localStorage` works and is persisted by the portal. Use it for high scores and saves.
8. Show a visible "click / tap to start" state, and support keyboard and touch input. Call `event.preventDefault()` on touch to stop double-tap zoom.
9. Render the first frame within 3 seconds. Create geometry procedurally and avoid large inline assets.

## Listening snippet
```js
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  if (e.data?.type === 'REWARD_GRANTED') revivePlayer();
});
```

Optional helper (available when running on Meshgrounds): `await window.Meshgrounds?.requestRewardAd()` resolves `true`/`false`.
