# sveltekit-cloudflare-worker b6bc029 (kit3-miniflare-runtime): Flarion test report (2026-11-08)

Branch `test/scw-kit3-miniflare` in the Flarion repo (commits 55cc738, 9ed5daf, b772b75, 35c0907). Nothing was pushed
and nothing deployed. **Verdict: b6bc029 passes everything, and the lazy `import()` fix works. Three issues are on
the package side.**

## Pin
pnpm can no longer resolve the short `f9ef0de` (it is no longer a branch tip). Flarion pins the full SHA
`b6bc029490747eb7a662bb344206bb934fdf4560`.

## Results (b6bc029)
- Unit and workers tests: 2042/2042. `pnpm check`: 0 errors.
- e2e:
  - Root config (P1/P2/P3 gates, auth, passkeys, api): 26/26.
  - Editor: 46/46.
  - App: 50/50 (one date-filter test failed once and passed on re-run).
  - Prod-build CSP: 2/2.
- f9ef0de root run: 4 failures, all on the Flarion side (dev mailbox, Vite reloads from mail files). Fixed, but not
  re-run on f9ef0de.

## SSR probe
A `+page.server.ts` calls the Workspace DO through `cloudflare:workers`, as the first request of a fresh server.
- **f9ef0de**: 500, then a D1 `QueryError`. The error:
  `A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.`
  The DO constructor runs `blockConcurrencyWhile(() => import(...))`.
- **b6bc029**: 200. The page title, the sidebar roots and `ping` render. Later requests take 55–700 ms, including
  right after a DO-module HMR. Flarion's literal-`import()` lazy shells work unchanged.

## Dev runtime: working
- Cron through `/cdn-cgi/handler/scheduled?cron=0+3+*+*+*` and `/__scheduled` (200; Workflows run).
- Queues and the indexing consumer.
- R2, now streamed.
- Rooms and the workspace socket.
- D1 batches, now atomic.
- KV, rate limits, Analytics Engine, Images `info()`.
- DOs from SvelteKit.
- HMR: `src/worker.ts` reloads in about 1 s without a restart. The WorkspaceDO implementation module and the shell
  class (a new method) reload with storage kept.

## Bindings
- **AI**: plain `AI.run` works through the remote proxy. With `{ gateway: { id } }` it fails with
  `AiGatewayError: 2001: Please configure AI Gateway in the Cloudflare dashboard`. That is account configuration;
  the gateway "flarion" has to be created before AI is usable on staging or production.
- **VECTORS**: every call throws `Error: Binding VECTORS needs to be run remotely` (not switched to `remote: true`,
  so dev doesn't hit the production index).
- **EMAIL**: `send` works locally, but it only writes files under `.wrangler/tmp/email`.

## Package-side issues and suggestions
1. **`import.meta.glob` of files outside `src` is denied in dev.**
   `import.meta.glob('/migrations/d1/*.sql', { query: '?raw' })` fails with
   `Error: Denied ID <root>/migrations/d1/0000_feature_flags.sql?raw`: SvelteKit narrows `server.fs.allow` and the
   module runner enforces it. Flarion's workaround is `server.fs.allow: ['migrations']`. Document it, or allow the
   project root for worker-side globs.
2. **Local `send_email` triggers page reloads.** It writes into `.wrangler/tmp`, inside the Vite root, so every mail
   causes a full reload. Flarion's workaround is `server.watch.ignored: ['**/.wrangler/**']`. The plugin could add
   that itself.
3. **Wasm compilation is refused in dev.** Repro: in `src/worker.ts` under `vite dev`,
   `await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]))` throws
   `CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder`. `.wasm` imports work in the
   build, so Flarion falls back to SQL in dev. Suggestion: support `.wasm` module imports in the runner, for example
   through workerd's `UnsafeEval.newWasmModule`.
4. **The composed facade changed shape.** The new facade (`import svelteKit from …`, `const next = () => …`) broke
   Flarion's own `scripts/postbuild.mjs` (its lazy-chunk rewrite). It's fixed on Flarion's side: the entry is now
   7 KB with 159 chunks. If the facade shape is meant to be stable, say so in `docs/architecture.md`.

## Flarion workarounds no longer needed (removed on the branch)
- The `devWranglerConfig` binding stripping.
- The per-resource-id suffixes for parallel dev servers (the worker-name suffix is kept).
- Sequential D1 batches in dev.
- R2 body buffering in dev.
- `PageDO.recordIdentity` and its `retryStart`. `ctx.id.name` is now set in dev, which also saves one RPC per room
  call.
- A D1 two-statement workaround.

## Flarion workarounds still needed
- The derived dev config, kept only for the origin vars and the `flarion-<port>` name.
- `typesFile: false` on derived configs: generated `vars` types are literals, so the file would be rewritten per
  port. A non-literal option would remove this workaround.
- The KV dev mailbox, which the e2e tests read.
- Fake AI for queue jobs.
- `vectorIndexOf` returning null in dev.
- The dev D1 auto-migration.
- The wasm SQL fallback.

Not re-tested: the Vite 504 after `pnpm add`.

## Types
`app.d.ts` keeps the optional secrets plus a small `App.Platform { env: Cloudflare.Env }` alias next to the
generated block. Note that `AI`, `EMAIL` and the other bindings are now required in `Cloudflare.Env`.

## Build and `wrangler dev`
Local mode, `--test-scheduled`:
- `/healthz`, `/login`, `/v1/docs` and `/v1/openapi.json` return 200.
- Unauthenticated `/ws` upgrades get 401 and `/rooms` gets 404 (both expected).
- Scheduled returns 200.
