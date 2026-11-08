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

## UI rule (owner requirement): entasis everywhere
Every UI element must be an entasis component when entasis has one: `DataTable`/`Table` for tables and
row lists, `Select` / `Combobox` / `PopupMenu` for selectors and pickers, `Dialog` / `confirmation()`,
`Tabs`, `TextInput` / `NumberInput` / `DateInput` / `TimeInput` / `RadioInput` / `Checkbox`, `Chip`, `Avatar(Group)`,
`Alert`, `Skeleton`, `Tooltip`, `Toast`… No native `<table>`, `<select>`, raw form inputs, hand-built
listboxes/menus/tabs/modals. Exceptions only where entasis has no equivalent, listed in
`docs/audits/entasis-audit.md` §5 (tree DnD, cover reposition, emoji grid, option color swatches) —
and an exception must be justified in a comment.

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

## Integration notes (P1 gate)
- **Gate e2e**: `tests/e2e/p1-gate.spec.ts` (two contexts, virtual authenticators, real dev server, no mocks). The dev
  database persists between runs (emails and slugs must be unique per run). Do not edit `src/` while an e2e run is
  going: HMR reloads the app. Commands are in "E2E suites" below.
- **Dev secrets**: copy `.dev.vars.example` to `.dev.vars` (gitignored): `ROOM_TOKEN_KEY`, `BETTER_AUTH_SECRET`,
  `API_TOKEN_PEPPER`, `TURNSTILE_SECRET` (Cloudflare's always-pass test secret).
- **Build version**: `vite build` embeds package.json's `version` as `VITE_APP_VERSION`; every client sends it (`x-app-version`,
  socket `?v=`). The dev server embeds nothing and the client says `dev`, accepted only when `ENVIRONMENT` is
  `development`/`test`. `APP_VERSION` in wrangler.jsonc (all three places) must equal package.json's version
  (`tests/unit/app-version.test.ts` checks it): bump them together, and raise `MIN_APP_VERSION` (`objects/workspace/versions.ts`)
  when the protocol breaks.
- **`/rpc` CSRF**: every client uses `SimpleCsrfProtectionLinkPlugin` (`x-csrf-token: orpc`).
- **D1 in `pnpm dev`**: batches (`$transaction([...])`) are NOT atomic behind Distilled's D1 proxy (dev only; workerd tests,
  staging and production run the real atomic batch). See `src/server/db/global.client.ts`.
- **Workers-test noise**: `uncaught exception; source = Uncaught (in promise); stack = WorkspaceError ...` lines in
  `vitest --project workers` come from `@cloudflare/vitest-plugin` 1.6.0's DO stub wrapper, not from our code: a trivial
  Durable Object whose async method does `throw new Error('x')` prints the same, while the real dev server (workerd) returns
  the decoded oRPC error (422 `VALIDATION_FAILED`) and logs nothing. The tests pass; ignore the lines.
- **Workspace rename**: `workspace.settings` writes D1 and a `rename` outbox job; the Workspace DO keeps the name in `meta`
  (`WorkspaceDO.rename`). Clients read the name from `rpc.me` (no live push yet).
- **Tree rows carry `createdBy`**: the sidebar's Private/Shared sections use it (`WorkspaceStore.privateRoots/sharedRoots`).

## E2E suites (P2 integration)
Every suite runs against a real `vite dev` (Worker, Durable Objects, D1, R2, passkeys; no mocks) that Playwright starts
itself on `E2E_PORT` and reuses when one is already there. Three Playwright configs, each with its own default port:

| Suite | Command |
| --- | --- |
| P1 gate, P2 gate, P3 gate, auth, passkeys | `E2E_PORT=5373 pnpm exec playwright test` (or one file: `... tests/e2e/p3-gate.spec.ts`) |
| Editor | `E2E_PORT=5273 pnpm exec playwright test -c tests/e2e/editor/playwright.config.ts` |
| App UI (sidebar, teamspaces, share, properties, pushes, files) | `E2E_PORT=5473 pnpm exec playwright test -c tests/e2e/app/playwright.config.ts` |

- **Concurrent servers are safe on distinct ports.** `vite.config.ts` gives a server on a non-default port its own
  worker name and local resource ids (`flarion-<port>`, D1/KV/R2/queue/workflow suffixes, see `isolateDevState`):
  Distilled's machine-wide registry (`~/.local/state/alchemy/registry/<script name>.json`) and its state under
  `.sveltekit-cloudflare-worker/local/<name or id>` are keyed by those names, so two `flarion` workers used to overwrite
  each other's registry entry and share SQLite files. Port 5173 (`pnpm dev`) keeps the plain names and the old state.
  Delete `.sveltekit-cloudflare-worker/local/*-<port>*` to reset one port's data.
- **Chromium**: Playwright's pinned build is used when cached; otherwise `tests/e2e/chromium.ts` picks the newest
  headless shell or Chromium under `~/Library/Caches/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH` is honoured).
  `E2E_CHROMIUM=/path/to/chrome-headless-shell` overrides it. Nothing to set up on a normal machine.
- The editor and app configs set `cwd` to the repo root for the `vite dev` command (Playwright runs it from the config's
  folder) and `E2E_FILES_HOST=[::1]`: user files are served from another host than the app (`FILES_ORIGIN`), so every
  image, cover and file download in those suites goes through the permission check and the signed redirect. The dev
  server listens on `localhost` (IPv6 loopback), hence `[::1]` rather than `127.0.0.1`.
- In dev the page code exposes `window.__flarion` (the workspace store) and `window.__edytor` (the open editor).
- Screenshots: `docs/screens/p1/gate-*.png`, `docs/screens/p2/{gate,app,editor}-*.png`, `docs/screens/p3/{gate,app,editor}-*.png`. Run the suites one at a time
  when you only need a pass/fail; they are parallel-safe, not CPU-free.

## Integration conventions learned in P2
- **Definition pushes** (`protocol.ts`): the Workspace DO sends every connected tab `{ t: 'registry', scopes, seq }` after a
  commit that changed property definitions (`properties`) or teamspaces, their members or workspace members
  (`directory`) (`registryScopesOf`); the store refetches `property.list` / `members.list` / `teamspaces.list`. A
  reconnect refetches too (the change log replays pages and values, not definitions). `{ t: 'lock', pageId, ... }` is sent
  when `page.lock.set` changes a lock, to the tabs that can read the page; `pageLocks` (`page-lock.svelte.ts`) applies
  it. There is no polling of either. New kinds of workspace-level data that live outside a subscription should
  join `registryScopesOf` instead of adding a timer.
- **Published pages** (`/share/:token`) are rendered by the Worker (`src/server/share/route.ts`, called from
  `src/worker.ts`), not SvelteKit: a Worker cannot reliably fetch its own hostname and SvelteKit server code must not call
  Durable Objects. P4 passes the `edytor/export` HTML to `renderSharedPage(page, bodyHtml)`. The response carries its own
  CSP; `img-src` and `media-src` name `env.FILES_ORIGIN`. **Any CSP added to the app (the plan's per-request nonce)
  must allow `FILES_ORIGIN` in `img-src`, `media-src` and `connect-src`**; the app sets none today.
- **Room tokens only narrow.** `resolveRoomAccess` returns `min(token claim, current level)`, so a redial after a grant was
  raised still gets the old level. `Editor.svelte` therefore takes the live page `access` and fetches a fresh token (the
  view remounts) when the tree says more than the token does. A page whose subscription answers with no row shows
  "This page doesn't exist" (`data-testid="page-unavailable"`), also after a revoked grant.
- **Comment-only people** get a read-only editor, and edytor hides its selection toolbar there: `EditorView.svelte` shows
  a "Comment" button over the selection (`data-testid="comment-selection"`).
- The files property uploads with the editor's `uploadToPage` (multipart included) and links its chips to the stable
  `/files/<id>?ws=` URL, not to a short-lived signed one.

## Integration conventions learned in P3
- **View rows carry their manual order.** `ViewRow` has `rank` (the key the engine breaks ties with: the member rank in a
  hand-picked-only collection, i.e. no source AST, else `page.rank`) and `parentId`; the live loop keeps them current with
  `$rank` / `$parent` `update` ops (a `moveMember` change row marks `$memberRank`, sent as `$rank`). A client reorders with
  `rankBetween(neighbour ranks)` and sends `moveMember` (hand-picked) or `move` with the row's own `parentId`
  (`ViewHost.moveRow`); it never reads the neighbours with `page.get`. Anything that builds view rows must pass the
  collection id (`RowReader.viewRows(..., collectionId)`, `engine/view.ts`). The fuzz compares `rank` and `parentId` too.
- **Definition pushes also cover databases.** `registryScopesOf` returns `collections` for `create/update/deleteCollection`
  and `create/update/move/deleteView`; the store refetches every collection it holds (and the ones a view asked for that
  did not exist yet). Member and value changes do not push a definition: they flow through the live loop.
- **Rows made from a view use the server's defaults.** `page.create` (and the `create` op) take `viewId` and `localFilter`;
  the DO runs `defaultsForView` (collection defaults, collection filter, view filter, local filter) and explicit `values`
  win. `page.create` also resolves the parent (the view's `$parent is X`, else the database page) when `parentId` is
  absent, then authorizes a plain `create` on it; the op path keeps the client's `parentId` (placement is authorized on
  the op). `WorkspaceStore.createViewRow` shows `newRowInit`'s prediction as the optimistic layer.
- **Window cap: 1,000 rows per view (or per group), `MAX_WINDOW`.** A bigger `limit` is refused by the schema, the table
  grows 100 rows at a time as it scrolls (`WorkspaceStore.growWindow`, which ignores a request that is not larger than the
  one already out) and stops at the cap with a note (`view-window-cap`, `board-window-cap`). Rows beyond the window are never
  sent. A `window` answer ends with `count` ops restating the totals: the client counts every `add`, so without them a
  resize double counted (found by `tests/e2e/p3-gate.spec.ts` test 7).
- **Computed values follow archive, restore and purge.** `afterWrite` runs for `archiveTeamspace` / `restoreTeamspace`
  records (every page of the teamspace, like a trashed subtree) and for the records a purge produces (relation cells that
  lost their target). `WorkspaceDO.#computedAfter` is the one place that does it outside `apply`.
- **Archived teamspaces are restored from Settings, not Trash** (Notion's behaviour): no trash entry is made. The archive
  stamps the teamspace and its pages with one `deleted_at` (pages trashed earlier keep their own entry);
  `workspace.teamspaces.archived` lists the ones the caller owns, `.restore` clears the stamp (`restoreTeamspace` change
  kind, an access-affecting record like the archive). The 30-day purge covers them.
- **`ai.regenerate` and `ai.ask` are P4 stubs** that answer `NOT_IMPLEMENTED` (501) with a message a toast can show and
  `data.feature` (`ai-property` / `ai-ask`). AI-property invalidation markers are P4 as well.
- **Gate numbers** (`tests/e2e/p3-gate.spec.ts`, real browsers, local dev): an edit reaches a collaborator's DOM in about
  15 ms p50 and 20 ms p95 over 20 edits; the workers measurement (`tests/workers/live/latency.test.ts`) has no network.
- Chromium headless: the comment margin needs a 1,700 px viewport for every thread to show a card.

## Integration conventions learned in P4 (App UI)
- **Quick find, search page, Ask AI**: `⌘K` is `shell/CommandPalette.svelte` over `search.quick` (order) + `search.query` (snippets, paths),
  debounced by `QuickFinder` (`src/lib/client/search.ts`); the search page is `/[ws]/search` (`components/search/SearchPage.svelte`, state in
  the URL); `⌘J` opens `components/ai/AskPanel.svelte` (entasis `AIChat`, streamed from `ai.ask` by `ai/ask.ts`, threads in
  localStorage `flarion.<ws>.<user>.ai.threads`). The panel switches itself off (banner, composer disabled, entry points hidden) when `ai.ask`
  answers `SERVICE_UNAVAILABLE` / `NOT_IMPLEMENTED`. **Dev AI**: set `localStorage['flarion:fake-ai'] = '1'` (dev build only): every AI call then
  carries `x-flarion-fake-ai` and the backend answers with its deterministic fake model (`src/lib/client/ai-rpc.ts`).
- **Accessibility settings**: Settings > Appearance has the theme and a contrast choice (`Match system` / `Standard` / `High contrast`,
  `src/lib/client/a11y.svelte.ts`, localStorage `flarion.contrast`) which sets `data-contrast="high"` on `<html>`; `generated/app-vars.css`
  then raises `--app-text-secondary/-tertiary/-sidebar` to the `highContrast` tokens (4.5:1 on every surface, `tests/unit/design-contrast.test.ts`).
  Standard contrast keeps Notion's softer text on purpose. Reduced motion needs no setting (generated CSS and entasis follow the OS).
- **`pnpm test:visual`** (`tests/visual/`, its own config, `E2E_PORT` default 5973): a `seed` project builds one workspace through the real app
  and RPCs (`seed.ts`: two people, a teamspace, a database with six views, a published page, trash), then `screens.spec.ts` compares
  **20 screens x 2 themes** (`__screenshots__/<screen>-<theme>.png`), `metrics.spec.ts` asserts computed row heights, font sizes and radii
  equal `notion.tokens.ts`, `a11y.spec.ts` runs axe (WCAG 2.0-2.2 A/AA) on the same 20 screens in both themes, with all rules in High
  contrast and every rule but `color-contrast` in Standard (the one exception: the sidebar's page tree, see the spec's header), and
  `mobile.spec.ts` checks the phone layout (390px, touch) and photographs 8 phone screens (`mobile-*-light.png`, in addition to the 40). Rendering is pinned (bundled Inter, clock at 2026-11-15 UTC, reduced motion, no
  caret, masks over times and ids); the baselines were made with Chromium on macOS, so regenerate them on another platform.
  Commands: `E2E_PORT=5873 pnpm test:visual` (all), `... pnpm test:visual screens|metrics|a11y` (one), `pnpm test:visual:update` (rewrite the
  baselines; look at the images before committing), `VISUAL_REUSE=1` (keep the seed of the last run). The dev server must have been started
  after the last `pnpm add` (a stale Vite cache answers `504 Outdated Optimize Dep`).
- **Phones** (< 768px): the sidebar is an overlay (entasis `Sidebar` offcanvas), dialogs collapse to bottom sheets (entasis `Dialog`), the Ask
  AI panel is full screen, the table scrolls sideways, the board snaps column by column.
