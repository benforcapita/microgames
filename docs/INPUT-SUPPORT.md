# Input support (IS-1)

Every game has `games.input_support`: `mobile`, `desktop`, `both` or `unknown` (default).

## Declaring it (runtime contract)
A game may declare which input it supports, either statically or from code. Both are optional and guarded, so the
file still runs outside Meshgrounds:

```html
<meta name="meshgrounds:input-support" content="both">
```
```js
window.Meshgrounds?.declare?.({ inputSupport: 'both' }); // 'mobile' | 'desktop' | 'both'
```

`Meshgrounds.inputSupport` reads back the value in effect (`declare()` wins over the meta tag; undeclared is
`unknown`). Invalid values are ignored. The runtime posts `__MG_META { inputSupport }` to the portal once per change.

Values and parsing live in `src/lib/input-support.ts` (runtime-neutral, shared with the static check and the
validate-game Edge Function). The static check (IS-2) compares the declaration with what the code actually listens to.
