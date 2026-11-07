# Flarion — Notion-class workspace on Cloudflare

The spec is `docs/PLAN.md` (exported from the plan doc). Implement it **to the letter**; when the plan
says "check exact syntax while building", read the library docs and adapt syntax, not intent.
Product name is **Flarion** (never use Notion's name, logo or fonts in the UI).

## Stack (pinned — do not upgrade)
- SvelteKit 3.1 + Svelte 5 runes, Vite 8, `sveltekit-cloudflare-worker` (vendored tarball; source/docs at `/Users/arnaud/code/sveltekit-cloudflare-worker`).
- edytor 7.0.4 (editor, Yjs-v14-style CRDT, `edytor/cloudflare` attachRoom/routeDocumentSocket). Docs: https://edytor.dev/docs , source at `/Users/arnaud/code/edytor`.
- viborm 1.12.1 (ORM; `viborm/permissions`, `viborm/soft-delete`, `viborm/ordering`, `viborm/d1`, `viborm/driver`). Docs: https://viborm.dev/docs , source at `/Users/arnaud/code/viborm` (may lag npm; trust `node_modules/viborm/dist` types first).
- entasis 0.16.0 (UI). Docs: https://entasis.beynar.workers.dev/docs ; types in `node_modules/entasis/dist`.
- oRPC **v1** (1.16.2) — decided in P0. Hibernation via `@orpc/server/hibernation`. Do not use v2 beta.
- better-auth 1.7.18 + `@better-auth/passkey`. Valibot for schemas (Standard Schema).
- Tests: Vitest 4. Project `unit` (node: `tests/unit/**/*.test.ts`, `src/**/*.unit.test.ts`) and project `workers` (real workerd + SQLite DOs via `@cloudflare/vitest-plugin`, config `wrangler.test.jsonc`, entry `tests/workers/entry.ts`, tests in `tests/workers/**/*.test.ts`; use `env`, `runInDurableObject` from `cloudflare:test`).

## Commands
- `pnpm exec vitest run --project unit` / `--project workers` / `pnpm test`
- `pnpm check` (svelte-check), `pnpm build` (vite build)
- `pnpm dev` — local dev. AI, Email, Images, Vectorize and crons are NOT available locally (vite.config.ts strips them into `wrangler.dev.jsonc`); code must treat `env.AI`, `env.VECTORS`, `env.EMAIL`, `env.IMAGES` as optional and degrade.
- Never run `wrangler deploy`, create Cloudflare resources or touch DNS: the orchestrator does that.

## Conventions learned in P0
- SvelteKit 3 removed `$lib`: import client/shared code as `#lib/...` (package.json `imports`) **with explicit
  `.ts`/`.svelte` extensions**; server code uses relative imports.
- Global `Env` (from `src/app.d.ts`) is the binding type; `Cloudflare.Env` is module-local there.
- Shared contracts (P0, `src/lib/shared/`): `property-types.ts` (registry, `encodeValue`/`decodeValue` → EAV rows),
  `sort-keys.ts` (`textSortKey`, `rankBetween`…, viborm/ordering-compatible ranks), `filter-ast.ts` (schema,
  `validateQuerySpec`, oracle `evaluate`/`queryRows`/`groupRows`), `ops.ts` (`opSchema`, `mutationBatchSchema`,
  `applyValueOp`), `protocol.ts` (socket messages, `CLOSE` codes 4401/4426…, `checkClientVersion`),
  `blocks/kinds.ts` (`KINDS_VERSION`, `roomSemantics`), `schemas.ts`, `public-api.ts`; oRPC contract in
  `src/server/rpc/contract.ts` (`contract`, `publicContract`).
- viborm on DO SQLite: `src/server/db/do-sqlite-driver.ts` (`createDurableObjectSqliteDriver(storage)`, one
  driver per storage; interactive tx = `storage.transaction`; never await I/O inside a tx; never call raw
  `ctx.storage.sql` while a tx is open), `src/server/db/driver/client.ts`, `driver/migrate.ts` (`migrateOnWake`).
  Policy in `src/server/db/policy.ts` uses actor *facts* (`actorFacts()`: subjects, teamspaces) to stay under
  100 bound params — read `docs/spikes/p0-policy-limits.md`.
- Workspace socket transport (oRPC v1 hibernation): `src/server/objects/workspace/socket.ts`
  (`@orpc/server/websocket` RPCHandler + `@orpc/server/hibernation`); tests use `evictDurableObject`.
- Rooms: `src/server/rooms/token.ts` (`mintRoomToken`, `verifyRoomToken`, `rt1.` HMAC tokens, 600 s),
  `src/server/rooms/access.ts` (`resolveRoomAccess` seam), Page DO named `workspaceId:pageId`.
- FTS5 (`docs/spikes/p0-fts5.md`): title boost by multiplying bm25 per field; rank in a MATERIALIZED CTE;
  quote user input before MATCH.
- Design: tokens in `src/lib/design/notion.tokens.ts`, `pnpm gen:theme` → `src/lib/design/generated/*`.
- `sveltekit-cloudflare-worker` is vendored: `vendor/sveltekit-cloudflare-worker-0.0.1.tgz`.

## Layout and ownership
`src/worker.ts` is the only Worker entry; it routes in plan order to `src/server/http/*-route.ts` and
re-exports DO classes, Workflows, `queue` and `scheduled`. Each route/class lives in its own module so
tracks do not edit the same file. Durable Object access happens only from `src/worker.ts`-side modules
(never from SvelteKit `+page.server.ts`/hooks: dev deadlock).

- `src/lib/shared/` — contracts shared by client and server (filter AST, property codecs, sort keys,
  block kinds, socket protocol, oRPC contract types). Pure TS, no Cloudflare imports.
- `src/server/rpc/contract.ts` — the oRPC contract.
- `src/server/db/` — viborm schemas, policy, `do-sqlite-driver.ts`.
- `src/server/objects/{workspace,page}/` — the two Durable Objects.
- `src/server/engine/` — filter compiler, IVM, formulas, rollups.
- `src/lib/design/notion.tokens.ts` — the single token file; `scripts/gen-theme.ts` generates themes.

Rules for parallel work:
1. Only edit files your task owns. If you must touch a shared file (`package.json`, `src/worker.ts`,
   `tests/workers/entry.ts`, `wrangler*.jsonc`, `src/app.d.ts`, `vitest.config.ts`), make the smallest
   additive edit and say so in your report.
2. Adding a dependency: `pnpm add <pkg>@<exact version>`; if pnpm reports a lock/store conflict, retry.
3. Do not commit; the orchestrator commits after validating each phase.
4. Every module gets tests. A track is done only when its tests pass and `pnpm check` has no errors in
   its files.
5. Report honestly: what works, what is stubbed, what deviates from the plan and why.
