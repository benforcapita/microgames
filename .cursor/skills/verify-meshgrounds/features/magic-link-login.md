# Magic-link login

A visitor signs in from `/login` by password, signs up, or asks for a magic link; the email lands in the local Mailpit inbox, and following the link signs them in via `/auth/callback`.

## Sub-features

- `auth-modes` `/login` chips under `Sign-in method`: `Log in`, `Sign up`, `Magic link` (`?mode=password|signup|magic`).
- `auth-magic-send` `Email me a link` → 303 to `/login?…sent=magic`.
- `auth-magic-mail` Mailpit receives "Your sign-in link" whose link's `redirect_to` is the portal's own `/auth/callback`.
- `auth-callback` opening the link signs in and lands on `next` (or `/onboarding` without a handle); `/auth/callback` with no code → `/login?error=…`.
- `auth-guard` `/me`, `/onboarding`, `/upload` 302 to `/login` when signed out; `/me` is `private, no-store`.

## How to get to it (user POV)

- Header `Log in` / `Sign up`.
- Any protected page while signed out (redirects with `next=`).

## Driving it with vmg.sh

Preconditions:

- `$V up && $V web`, doctor OK; Mailpit at `$MAILPIT_URL` (block port +5). `D=$($V evidence magic-link-login); W=http://127.0.0.1:55668; E=vmg-$VMG_RUN_ID@example.test`.

- **Create the account** (magic links only go to existing users unless sign-up is allowed): sign up as in `upload-submission.md`.
- **Request the link (browser).** Open `/login?mode=magic`, fill `email`, click `Email me a link`; expect the URL to contain `sent=magic`. Or curl: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $W" -F mode=magic -F email=$E -F next=/me $W/api/auth/login` → `303 …sent=magic…`.
- **Read it from Mailpit.** `$V exec -- bash -c 'curl -s "$MAILPIT_URL/api/v1/search?query=to:'$E'"'` → newest message `Subject: Your sign-in link`; fetch `/api/v1/message/<ID>` and extract the first URL from `.Text`. Save it to evidence with the token redacted (`sed 's/token=[^&]*/token=REDACTED/'`). Expected shape: `http://127.0.0.1:55660/auth/v1/verify?token=…&type=magiclink&redirect_to=http%3A%2F%2F127.0.0.1%3A55668%2Fauth%2Fcallback…`.
- **Follow it.** In a Playwright page, `goto(link)`; expect final URL `/me` (or `/onboarding` without a handle) and the header to show the account instead of `Log in`. Capture screenshot + ARIA.
- **Negative.** `curl -s -o /dev/null -w '%{redirect_url}' $W/auth/callback` → `/login?…error=…`.
- **Repo coverage.** `npm run smoke` asserts signup, bad password, magic-link send, callback without code, sign-in, logout.

## Gotchas

- Without `vmg.sh up`'s `additional_redirect_urls` edit, Supabase rejects the block's portal port and the link falls back to `site_url` (another port) — the click then lands on nothing or on someone else's server.
- Use the link once; GoTrue tokens are single-use and expire. Request a new one per attempt.
- Never print or store the raw link; it is a bearer credential for that test user.
- Production: no login attempts, no magic-link requests (they send real email).
