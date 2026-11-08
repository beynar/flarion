# Email (invites, guests, mentions, recovery)

All mail goes through `src/server/mail/index.ts` (`sendMail`).

| Environment | What happens |
| --- | --- |
| `pnpm dev`, workers tests (`ENVIRONMENT` is `development` or `test`, no `EMAIL` binding) | The mail is logged to the console and kept in the KV mailbox `dev:mail:last` (newest first, last 20; `readDevMails`, `firstLink`). Invite and recovery links are read back from there. |
| staging, production | `env.EMAIL.send({ from: env.MAIL_FROM, to, subject, html, text })` through the Email Service `send_email` binding. A missing binding in production is an error (no silent fallback). |

`MAIL_FROM` is `noreply@beynar.dev` in the staging and production `vars` of `wrangler.jsonc` and `noreply@flarion.local` locally.

## What sends mail

- Verification, recovery and workspace invite mails: synchronous, from the request that triggers them.
- Guest invite (`page.grants.set` with an email that is not a user) and "page shared" (an existing user added as a guest): synchronous.
- Mention mails: asynchronous. `WorkspaceDO.ingestPages` -> `objects/workspace/mentions.ts` queues `{ type: 'email', template: 'mention', to, data }` on `JOBS`; `queues/email.ts` sends it (retry with backoff on failure). A person opts out with `user.notifyMentions = false` (default true; no settings UI yet).

Templates (`src/server/mail/templates.ts`) all return `{ subject, html, text }`, name the product Flarion, escape user text in the HTML and carry the full link in the text part.

## Onboarding `noreply@beynar.dev` (orchestrator, once per Cloudflare account)

Prerequisite: the `beynar.dev` zone is on this Cloudflare account, and the Workers have `"send_email": [{ "name": "EMAIL" }]` (already in `wrangler.jsonc`, top level, `staging` and `production`).

1. Enable sending on the domain:
   ```bash
   npx wrangler email sending enable beynar.dev
   npx wrangler email sending dns get beynar.dev   # the SPF and DKIM records it adds
   ```
   Or in the dashboard: Compute & AI > Email Service > Email Sending > Onboard Domain > `beynar.dev` > Add records and onboard.
2. Wait for DNS (usually 5-15 minutes) until the domain shows as verified.
3. Add a DMARC record if the zone has none, e.g. `_dmarc.beynar.dev TXT "v=DMARC1; p=none; rua=mailto:dmarc@beynar.dev"`, and tighten to `quarantine` once reports look clean (deliverability).
4. Send a test from staging before production:
   ```bash
   npx wrangler email sending send --from noreply@beynar.dev --to you@example.com --subject "Flarion test" --text "ok"
   ```
5. Deploy staging, sign up with a real address you control and check the verification mail and its link; invite a second address as a guest from a shared page.

Notes:
- The `from` address may be any mailbox on an onboarded domain; keep it `noreply@beynar.dev` so replies are not expected.
- Email Service is transactional only: do not use it for newsletters.
- Use real addresses in tests: bounces from fake addresses hurt the sender reputation. Locally nothing is sent.
- To send real mail from `wrangler dev` use `"remote": true` on the binding (remove before deploying); `vite dev` and `wrangler dev` run `send_email` locally (Miniflare writes each message under `.wrangler/tmp/email` and delivers nothing), and in development the KV mailbox keeps a copy for `/api/auth/dev/mails`.
- Account sending limits and suppression lists: dashboard > Email Service. A bounce suppresses the address; the invite flow surfaces a 500 ("The invitation email could not be sent") when the send call itself fails.
