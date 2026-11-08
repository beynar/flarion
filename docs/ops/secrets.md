# Secrets, rotation and abuse limits

Everything secret is a **Worker secret** (`wrangler secret put NAME [--env staging|production]`); `.dev.vars` (copy of
`.dev.vars.example`, git-ignored) holds local values. docs/PLAN.md "Secrets: the better-auth secret, room-token key and
API-token pepper are Worker secrets, rotated with a two-key overlap."

## Inventory

| Secret | What it protects | Min | Rotation overlap |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | Session cookie signature, email-verification and registration tokens | 32 chars | `BETTER_AUTH_SECRET_PREVIOUS` |
| `ROOM_TOKEN_KEY` | edytor room tokens (`rt1.`, 10 minutes), signed file URLs | 16 chars | `ROOM_TOKEN_KEY_PREVIOUS` |
| `FILES_URL_KEY` (optional) | Signed file URLs only, when you want them apart from the room key | 16 chars | `FILES_URL_KEY_PREVIOUS` |
| `API_TOKEN_PEPPER` | HMAC key of API token hashes in D1 | 8 chars | `API_TOKEN_PEPPER_PREVIOUS` |
| `TURNSTILE_SECRET` | Turnstile server-side verification | | replace |
| `ANALYTICS_API_TOKEN` | Reading Analytics Engine for the SLO dashboard and alerts | | replace |
| `ALERT_EMAIL` (secret or var) | Where the alert cron mails | | replace |
| `ADMIN_KEY`, `LOAD_TEST_KEY` | Recovery routes and the staging load test (`docs/ops/restore.md`, `load-test.md`) | | replace |
| `ADMIN_EMAILS` (var or secret) | Narrows the SLO dashboard to these people | | replace |

`scripts/deploy.sh` requires the first three secrets of the table (`BETTER_AUTH_SECRET`, `ROOM_TOKEN_KEY`, `API_TOKEN_PEPPER`) and warns about
the optional ones it does not find, as a secret or as a var in `wrangler.jsonc`: `TURNSTILE_SECRET`, `ADMIN_KEY`, `LOAD_TEST_KEY`,
`ANALYTICS_API_TOKEN`, `ALERT_EMAIL`, `ADMIN_EMAILS`. The app runs without any of them and says what to set.

A previous key is verified, never signed with. The procedure is the same each time:

1. `wrangler secret put <NAME>_PREVIOUS` with the **current** value.
2. `wrangler secret put <NAME>` with the **new** value.
3. Deploy (secrets apply to the next version; `wrangler secret put` already creates one).
4. Wait out the overlap (below), then `wrangler secret delete <NAME>_PREVIOUS`.

## Per secret

### Room-token key (`ROOM_TOKEN_KEY`)

`src/server/rooms/token.ts` signs with the current key and verifies against the current, then the previous. Room tokens live
ten minutes and the editor refreshes on close code 4401, so the overlap is **15 minutes**. Signed file URLs
(`src/server/files/sign.ts`, a few minutes) verify against the same pair, or `FILES_URL_KEY` and its previous when set.

### API-token pepper (`API_TOKEN_PEPPER`)

Tokens are stored as `HMAC-SHA256(pepper, secret)` (`src/server/auth/api-tokens.ts`). Authentication hashes the presented
secret under the current pepper and the previous one and looks both up. A token found under the previous pepper is
**rewritten under the current one on that request**, so the overlap needs no migration job: once every token still in use
has been seen at least once (a day for a busy integration, a month for a monthly job), drop the previous pepper. A token
that was not seen by then stops working; the owner makes a new one. No token is ever re-shown: only hashes exist.

### better-auth secret (`BETTER_AUTH_SECRET`)

better-auth signs its session cookie with a single secret and cannot verify an older one, so a plain rotation signs
everybody out. `src/server/auth/secret-rotation.ts` closes that gap: with `BETTER_AUTH_SECRET_PREVIOUS` set, a session
cookie signed with the previous secret is **re-signed under the current one** before better-auth reads it (in `/api/auth/*`
and in every `resolveSession`), and `/api/auth` responses set the re-signed cookie, so the browser migrates on its next
auth call (the app boots with `get-session`). Sessions live in D1, nothing else depends on the secret. Registration tokens
(ten minutes) verify under both. Email-verification links minted before the rotation (24 hours) stop working: the user asks
for another. Keep the previous secret **at least a day** (the app refreshes its session daily), up to the 30-day cookie life
if you want nobody to sign in again; whoever is not seen by then signs in with their passkey.

### Pepper, key and secret compromise

If a key leaked, do not overlap: set the new one and delete the previous at once. For the pepper that revokes every token
(`UPDATE apiToken SET revokedAt = ...` or let them fail); for the better-auth secret everybody signs in again; for the room
key every open page reconnects with a fresh token.

## API tokens

`flr_` plus 32 random bytes, shown once. D1 `apiToken` keeps the keyed hash, the scopes (an empty list grants nothing), an
optional expiry, `lastUsedAt` (stamped at most once a minute) and `revokedAt`. Every request writes an `api` data point
(token id, route, status class, latency) to Analytics Engine, never the secret. Revoked, expired and unknown tokens are all
`401`; a token whose user left the workspace is `401` too. A token acts as its creator, with their access in one workspace,
narrowed by its scopes.

## Abuse limits (verified)

| Surface | Limit | Where |
| --- | --- | --- |
| Sign-in, sign-up, passkey and recovery endpoints (`/api/auth/*`, except `get-session` and `ok`) | `RL_AUTH`: 20 requests a minute per IP and path | `http/auth-route.ts`; `RL_AUTH` in `wrangler.jsonc` (staging `1011`, production `1001`) |
| Invites | `RL_AUTH` keyed `invite:<userId>`: 20 a minute, plus a verified email, a role check and at most 100 pending invites | `auth/workspaces.ts` (`limitInvites`, `createInvite`) |
| Published pages (`/share/:token`) | `RL_PUBLIC`: 120 a minute per IP (and a missing or revoked token is a plain 404; pages are `noindex`) | `share/route.ts`; `RL_PUBLIC` |
| Public API | `RL_API`: 300 a minute **per token** (`429` and `Retry-After`) | `rpc/public/base.ts`; `RL_API` |
| Page rooms | edytor's default of 50 sync messages a second per socket (refused frames close the socket) | edytor `attachRoom` defaults |
| Request bodies | 4 MiB on `/rpc`, 2 MiB on `/v1` | `rpc-route.ts`, `public-api-route.ts` |

The `ratelimits` limits are set per binding in `wrangler.jsonc`; raise `RL_API` if an integration needs more.

## Content-Security-Policy

Documents (the app) get a per-request nonce policy from the Worker, around `next()` in `src/worker.ts` (`withCsp`, `src/server/security/csp.ts`):
scripts only with the nonce, `FILES_ORIGIN` in `img-src`, `media-src` and `connect-src`, Turnstile and the editor's embed
players in `frame-src`, the app's own `ws:`/`wss:` origin in `connect-src`. Published pages (`share/route.ts`) and the API
reference (`/v1/docs`, which allows the pinned Scalar build on jsDelivr) send their own. A new third-party origin must be
added to `buildCsp` (and its test), or it is blocked.

`vite dev` relaxes `style-src` (inline `<style>` elements are allowed there), so the policy is checked on the production build:
`pnpm build && pnpm exec playwright test -c tests/e2e/prod/playwright.config.ts` serves the built Worker with `wrangler dev` over HTTPS
(`tests/e2e/prod/serve.mjs`: `ENVIRONMENT=staging`, which sends the same policy as production and accepts the local Turnstile test
secret; user files on another origin) and drives login, the editor, a database, quick find, Ask AI, the share dialog and a published page,
failing on any `securitypolicyviolation` event or "Refused to" message. It found one: edytor's comments plugin adds a `<style>` to `<head>`
at run time with no nonce, which production would block (the comment highlight would not paint). `stampStyleNonce()` (`src/lib/client/csp.ts`,
called by the root layout) now stamps the document's nonce on every `<style>` the page creates.
