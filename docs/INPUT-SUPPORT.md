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

## Detection and backfill (IS-2 / IS-4)

The static check classifies every upload and validate-game stores the result in `games.input_support`. To classify games uploaded before that, run:

    npm run backfill:input                   # DRY RUN (default): report only, writes nothing
    npm run backfill:input -- --apply        # fill rows still 'unknown' (local stack by default)
    npm run backfill:input -- --apply --force --ids a,b   # ids must match ^[A-Za-z0-9_-]{1,32}$

It always runs in REST mode (PostgREST + Storage). A non-local project needs `--allow-remote` and the typed project ref, or `--yes`. Hosted runs need Ben's approval.
