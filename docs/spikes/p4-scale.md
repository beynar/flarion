# P4 spike: scale (Sync core)

Profiling a workspace of 20,000 to 50,000 pages with many open shared views, the decision on Roaring bitmaps, and the
cheap wins the profile asked for. Code: `src/server/bitmaps/`, `src/server/objects/workspace/{live,view-unit,access,level-map,
option-sync,governor,location}.ts`, `src/server/engine/{sources,compile}.ts`; tests: `tests/workers/scale/`; harness:
`tests/workers/scale/{harness,profile.test}.ts`, `scripts/scale/profile.mjs`.

## Decision

**Bitmaps were implemented**, but for a different reason than the plan guessed. The plan said "when profiling shows filters or
fan-out dominating". Profiling says:

- **Filter evaluation is not what dominates.** A full query over 20,000 pages is 23 to 75 ms whatever the filter: a hot `status`
  value (11,000 matches) costs the same as a cold one (1,300), because every query pays for the collection's membership (a scan of
  its 20,000 children) and the sorted window first. The engine's SQLite range scans over the clustered EAV tables are fine to
  50,000 pages (77 ms for 28,000 matches). The first measurement's 137 ms for the hot value was taken on a busier machine with cold caches and did not repeat.
- **Fan-out dominates, and inside it one thing: deriving each socket's window.** Every commit, for every subscription whose
  unit it touched, `LiveHub` ANDed the unit's whole id list with the actor's visibility set, once for the window before the
  commit and once for the window after: O(pages in the view) per subscription. That was 80 to 95% of the fan-out
  (`derive` below) and it is what bitmaps fix: the visible total is one bitmap intersection, a view that is entirely
  visible is cut by slicing it, and otherwise the list is read only as far as the window reaches.
- **Candidate checks had a planner cliff** (a bug, not a data structure problem): with five or more candidate pages SQLite
  switched from the candidates to a scan of the whole database for `page` conditions (45 ms at 20,000 pages for 10 candidates;
  0.1 ms for 2). Fixed in `engine/sources.ts` (see "Cheap wins").
- **Memory is the real wall.** See "Memory": with real 36-character ids the live units alone pass 128 MB at 50,000 pages and a
  hundred open views; per-actor visibility maps cost 1.85 MB each. Both are fixed without bitmaps (interned ids, a byte per
  page number), and bitmaps keep the rest small.

So the rule "start with range scans, add bitmaps when profiling asks" held, with the ask in a different place: the **option
index** (one bitmap per select / status / multi-select / person option) answers filter conditions and halves the
unit-maintenance cost of a hot `status` write (`maintain` 38 to 17 ms at 20,000 pages), and the **visibility and view
membership bitmaps** remove the per-socket O(N) derivation (`derive` 119 to 4 ms).

## Method

`seedScale` (`tests/workers/scale/harness.ts`) fills a real Workspace DO through the EAV write path: a database of N pages
with `status` (default groups, skewed to two values), `prio` (select), `assignee` (person, 60 people, zipf), `tags`
(multi-select, 24 options, zipf), `amount`, `done`, `notes`; 13 s for 50,000 pages. `scaleViews` makes 120 distinct view
subscriptions (filters on status, priority, people, tags and combinations; four sorts; boards grouped by status), each its own
shared unit: "many open views", the worst case of a hot `status` write. 40 sockets (5 actors) each subscribe to 8 of them.
`profile.test.ts` measures, in real workerd on a laptop:

1. the engine: full queries and `matchesFilterMany` candidate checks, per filter;
2. the cold first window of a view (a unit nobody has evaluated);
3. writes against every open view: a hot `status` write, `assignee`, `amount`, `notes` (no view filters it, but views show it),
   a batch of 20 status writes; the commit alone (nobody listening) and the fan-out broken down by `liveStats().perf`
   (`maintain` = bringing the units up to date, `derive` = each socket's diff, `send`);
4. what the live loop holds (bytes of unit state, of the option index).

It runs the whole thing twice on fresh workspaces: `sql` (bitmaps off: `setRoaringEnabled(false)`) and `bitmaps`.

```sh
pnpm scale:profile                                  # 20,000 pages, 120 views, 40 sockets x 8, 30 writes per kind, both modes
pnpm scale:profile -- --pages 50000 --writes 20
VITE_SCALE_PAGES=3000 pnpm exec vitest run --project workers tests/workers/scale/profile.test.ts   # the smoke run (a few seconds)
```

Not measurable here: CPU time per invocation (workerd's clock follows I/O, `performance.now()` does advance during synchronous
work in the test pool, as the numbers show) and heap size (workerd exposes none to its code). Wall time of one synchronous commit
on one thread is the CPU cost; memory is estimated from the sizes of what is held (below) and from V8 measurements in Node.

## Results

Milliseconds, laptop, workerd, 120 shared views, 40 sockets x 8 subscriptions. "Before" is the first measurement, with none of the
changes; "SQL paths" is the same code with bitmaps off (planner fix, caches); "bitmaps" is everything.

### 20,000 pages

| | before | SQL paths | bitmaps |
| --- | ---: | ---: | ---: |
| candidate check, 10 pages, with a collection | 42 | 3 | 3 |
| full query, `status is X` (11,383 matches), sorted | 137 | 34 | 27 |
| connect 40 sockets x 8 views (120 cold units) | 32,005 | 7,996 | 7,607 |
| cold first window per view, p50 / p95 | 60 / 576 | 23 / 69 | 22 / 59 |
| **hot `status` write, mean** (fan-out) | 139 (130) | 143 (134) | **34 (26)** |
| of the fan-out: maintain / derive | 16 / 108 | 40 / 91 | 18 / 4.0 |
| `assignee` write, mean | 106 | 68 | **14** |
| `amount` write, mean | 123 | 84 | **25** |
| `notes` write (no view filters it, views show it), mean | 195 | 49 | **11** |
| batch of 20 status writes | 2,332 | 868 | 726 |
| commit alone | 3.7 | 2.1 | 2.6 |

### 50,000 pages

| | SQL paths | bitmaps |
| --- | ---: | ---: |
| full query, `status is X` (28,487 matches) | 77 | 82 |
| connect 40 sockets x 8 views | 20,797 | 17,230 |
| cold first window per view, p50 / p95 | 55 / 184 | 47 / 142 |
| hot `status` write, mean (fan-out) | 366 (351) | **52** (41) |
| of the fan-out: maintain / derive | 97 / 248 | 30 / 3.8 |
| `assignee` write, mean | 176 | **17** |
| `amount` write, mean | 280 | **39** |
| `notes` write, mean | 145 | **13** |
| batch of 20 status writes | 2,203 | 1,451 |

(One run each; the "SQL paths" column of this table was measured before the interned ids, the visibility byte map and the shared
derivations, none of which touch that path much.) The sockets of the profile are spread over 5 people with different sets of views;
with one person per socket (`--actors 40`, 20,000 pages) a hot write costs the same, 32 ms (derive 4.1 ms): the profile's views are
too varied for derivations to be shared, so the speed-up above comes from the window fast path, not from sharing.

State the live loop holds: 117 view units = 4.4 MB of JSON at 20,000 pages (8.9 MB at 50,000); the option index (4 properties, 60
people, 24 tags) = 160 KB at 20,000 pages (276 KB at 50,000); a dense 50,000-page bitmap is under 200 bytes (run containers).

What is left: a hot write at 50,000 pages and 120 distinct open views still pays `maintain` (the units are brought up to date
one by one, about 0.3 ms per touched unit for one candidate page and about 8 ms per unit for 20 candidates: the binary search
over a unit's stored order loads sort tuples from SQL, probe by probe) and a batch of many pages grows with the candidate count
(`MAX_INCREMENTAL` = 40 candidates, past which a unit is evaluated in full: 25 ms per unit at 20,000 pages). See "When to
revisit".

## 1,000 tabs

The profile above has 40 sockets on 120 different views, the opposite of the plan's target (one workspace, 1,000 tabs, most of them on a handful
of boards). Two more runs, same harness (`--views 8 --sockets N --actors P`), 500 to 2,000 pages, hot `status` write, mean (p95):

| tabs x views | people | mode | write mean (p95) | fan-out: derive / send | subscriptions touched / shared |
| --- | ---: | --- | ---: | ---: | ---: |
| 200 x 8 on 8 shared views | 10 | SQL paths | 12.9 (21) | 5.5 / 0.6 | 447 / 424 |
| 200 x 8 on 8 shared views | 10 | bitmaps | 10.6 (16) | 3.6 / 0.7 | 447 / 424 |
| 1,000 x 8 on 8 shared views | 25 | SQL paths | 56 (142) | 35 / 3.0 | 1,950 / 1,901 |

At 1,000 tabs the object spends about 40 ms of fan-out per hot write, which is what the plan's 150 ms p95 target needs; the rest of the
cost is the 49 distinct derivations (25 people x their shapes, 0.5 ms each, mostly reading the rows that enter a window) and the loop over
1,950 touched subscriptions (about 2 ms). Not measured here: the network (1,000 `ws.send` calls over real sockets per commit) and
Cloudflare's CPU: that is what the staging run (`docs/ops/load-test.md`) is for.

The local `pnpm dev` runs of the load tool (`docs/ops/load-test.md`, SQL paths since dev cannot load the WASM module, server and
Node client on one laptop): 200 tabs, 8 views, 10 writes/s: write round trip p50 **27 ms**, edit-to-diff p50 23 / p95 34 ms. Before the
changes of this phase the same run saturated (write round trip p50 7.7 s, edit-to-diff p95 8.6 s, about 5 commits per second). At 1,000
tabs, 10 writes/s the laptop still saturates (write round trip p50 3.3 s, edit-to-diff p95 4.1 s): one thread of workerd and one Node
process share the machine, and the Node client alone parses 9,000 frames per second. That run is not evidence either way for staging.

## Cheap wins (all in)

- **Materialized candidate probes** (`engine/sources.ts`): `WITH cand AS MATERIALIZED (SELECT ... WHERE num IN (...))` then the
  predicate. SQLite has no statistics for these tables and, from the fifth candidate on, preferred the `parent_id` index (or the
  `(prop, v)` primary key of `p_ref`) and read every row of the value. Candidate checks went from 45 ms to 2 ms and no longer grow
  with the collection.
- **No O(N) per commit per actor in the access service**: a dirty subtree (every page create) used to copy the actor's whole
  visibility map; it is changed in place now.
- **One derivation per (unit, person, window shape) per commit** (`derived` in `LiveHub.fanOut`): a diff is a function of the unit,
  the window sizes, the shown properties and the actor's visibility, so the tabs of one person, and subscriptions of the same shape,
  share it. With 1,000 tabs from a few hundred people this is the difference between thousands of derivations per commit and a
  few hundred ("1,000 tabs" below). The message object is shared too, and `encodeServerMessage` remembers its encoding per object, so 1,000
  tabs cost a few serializations, not 1,000.
- **Cached subscription rows and stream ids** in `LiveHub` (a fan-out read two SQL rows and parsed JSON per affected
  subscription, and one row per socket to send); a window of a unit that did not change, for an actor whose visibility did not,
  is derived once instead of twice.
- **Interned page ids** (`view-unit.ts`): one string per page shared by every unit that holds it. Measured in Node: 800,000
  36-character ids over 40 units = 51 MB as parsed, 11 MB interned.
- **Visibility sets as a byte per page number** (`level-map.ts`): 1.85 MB to about 50 KB per connected actor at 50,000 pages, no
  copy per page create, and the engine's `visible` option takes a copy-free view of it (a request used to build a 50,000-entry
  `Set` and a 50,000-entry level map per `queryView`).
- **A bulk fill of the id-to-number cache** when a big unit is read for the first time after the object woke (one pass over `page`
  instead of hundreds of chunked lookups).
- **The runbook** (below): hidden tabs and merged fan-outs while overloaded.

## Bitmaps

### The package

`roaring-wasm` 1.1.0 (CRoaring compiled to WebAssembly, Apache-2.0, in use since 2019; its last release is October 2024), pinned in
`package.json`. It is the only CRoaring WASM package that is not a young single-purpose crate (`@jeange/roaring-wasm` is three months
old); `roaring` is a native Node addon and cannot run in workerd.

**It does not run in workerd as published**: workerd refuses to compile WebAssembly at run time ("Wasm code generation disallowed
by embedder"), and the package's loader compiles its embedded copy. `patches/roaring-wasm.patch` (a pnpm patch, 5 lines, in
`package.json` `pnpm.patchedDependencies`) makes the loader instantiate a `WebAssembly.Module` handed over in
`globalThis.__ROARING_WASM_MODULE__`. With that, in workerd: 200,000 `has()` calls take 2 ms (10 ns each), a dense 50,000-page
bitmap serializes to under 200 bytes (`tests/workers/scale/roaring.test.ts`).

**Getting the module into the deployed Worker** is the delicate part, because `sveltekit-cloudflare-worker` bundles `src/worker.ts`
with an esbuild that has no `.wasm` loader (a static `import wasm from '....wasm'` fails `pnpm build`). So:
`src/server/bitmaps/wasm-source.ts` imports `./roaring.wasm` dynamically with a specifier the bundlers cannot see;
`scripts/postbuild.mjs` (run by `pnpm build`, `deploy` and `deploy:staging`) copies `node_modules/roaring-wasm/index.wasm` next to
`_worker.js` as `roaring.wasm` and adds it to `.assetsignore`; `wrangler.jsonc` has `find_additional_modules: true` (top level, staging and
production; wrangler's default rules already type `**/*.wasm` as `CompiledWasm`) so wrangler uploads it as a module of the Worker. The workers tests alias
`./wasm-source` to a static import (`vitest.config.ts`, `tests/workers/scale/wasm-source.ts`), which is how the test pool loads
CompiledWasm. `pnpm dev` (workerd, where `WebAssembly.compile` is disallowed) cannot resolve it: **bitmaps are an accelerator, never a dependency.**
`ensureRoaring()` resolves `false` when the module cannot load, logs once, and every caller keeps its SQL path (the same degradation as
`env.AI`). Setting the Worker var `BITMAPS` to `"off"` turns them off in a deployed object: the rollback switch.

*Checked here:* `wrangler deploy --dry-run` for the top level, `staging` and `production` attaches `roaring.wasm` (compiled-wasm, 169.5 KiB)
next to the 10.6 MB `_worker.js`; and a probe Worker with the same layout (`find_additional_modules`, the module next to the main file, the
specifier built at run time) run in local workerd (`wrangler dev --local`) imports it as a `WebAssembly.Module` and instantiates it.
`pnpm dev` cannot (Vite's module runner answers "Denied ID /src/server/bitmaps/roaring.wasm"): there the library logs that it is
unavailable once and everything runs on the SQL paths, which is how `pnpm dev` and the 1,000-tab local run below were measured.
*Not checked until staging:* Cloudflare's own upload. The first staging deploy logs `[bitmaps] roaring-wasm ready` when a Workspace DO wakes, or
`[bitmaps] roaring-wasm is unavailable` (and `liveStats().bitmaps` is `null`).

### What is indexed and how it stays right

| | keyed by | answers | kept current by |
| --- | --- | --- | --- |
| **Option index** (`bitmaps/option-index.ts`) | `(property number, option or person id)` over `page.num`, plus a "has any value" bitmap per property | `is`, `is not`, `contains`, `does not contain`, `is me`, `is empty`, `is not empty` on select, status, multi-select, person: the engine's leaf source (`engine/sources.ts` `bitmapSource`) for `runQuery`, `matchesFilter`, `matchesFilterMany` | built lazily per property from `p_ref` on first read after the object wakes (nothing persisted: 100 to 300 ms at 50,000 pages, once); every commit re-reads the written (property, page) pairs from `p_ref` (`option-sync.ts`) so live typing coalescing in the log cannot make it drift; a property definition change drops that property; purge drops pages; restore drops everything |
| **View membership** (`ViewState` bits per list) | page numbers of a view unit's list | the visible total of a list is `andCardinality` with the actor's bitmap, the distinct total of a grouped view an `or` then `and`, "everything is visible" is `total == size == list length` | built from the engine's result when a unit is evaluated, cloned and adjusted by the incremental maintenance (`maintainView`), built lazily from ids when a state is parsed after a wake |
| **Visibility** (`Entry.bits` in `access.ts`) | the pages an actor can read | the right-hand side of those intersections | rebuilt with the level map, copy-on-write on a subtree change; the "before the commit" side is used only when the actor's visibility did not change in the commit, otherwise the old slow path runs |

Equivalence is tested, not assumed:

- `tests/workers/scale/bitmaps.test.ts`: the engine **with** bitmaps against the same naive oracle as `tests/workers/engine/oracle.test.ts`
  (8 seeds, 60 random three-level filters, sorts, groupings, windows, collections and visibility sets each), every operator on every
  indexed type, `matchesFilter(Many)` against the oracle, and a real Workspace DO through the commit path (value writes, `addOption`,
  `removeOption`, option edits through `updateProperty`, trash, restore, purge, coalesced live typing, hibernation) asserting
  `drift` against `p_ref` is empty every 20 steps. Removing the `refresh` call fails it at step 19.
- The live-update fuzz (`tests/workers/live/fuzz.test.ts`) runs with bitmaps on; `staleUnits` compares each unit with a fresh
  evaluation that does **not** use the option index, and compares each in-memory membership bitmap with its ids. A 60-seed sweep
  (`VITE_FUZZ_SEEDS=60 VITE_FUZZ_FROM=100`) passed.

## Memory

Budget (docs/PLAN.md): 128 MB per object, about half for subscriptions, visibility sets, bitmaps and row caches. Measured in V8:

| what | per | at 50,000 pages |
| --- | --- | --- |
| ids of a view unit as parsed strings (36-char ids) | 64 bytes an id | 3.2 MB per unit that matches every page |
| the same, interned (pool shared by all units) | 8 bytes an id + one pool of strings | 0.4 MB per unit + 3 MB once |
| a visibility `Map<num, level>` (before) | 37 bytes a page | 1.85 MB per connected actor |
| a visibility byte array (`LevelMap`, now) | 1 byte a page | 50 KB per connected actor |
| dense bitmap | | under 200 bytes |
| option index, 4 properties | | 160 KB at 20,000 pages |

Before the changes, 120 open views averaging 40% of 50,000 pages (2.4 million ids) and 25 actors needed about 150 MB for ids and 46 MB for
visibility maps: over the limit, and an object that runs out of memory is reset, which makes every socket reconnect at once.
After: about 25 MB for ids and 1 MB for visibility. The profile's peak workerd resident set (the whole test runtime, not the
object) was 636 MB at 20,000 pages; it says nothing about the object's isolate and is printed only so a regression is visible.

## When to revisit

- **Ids still cost 8 bytes a slot and a string per page.** Past about 1.5 million ids across the live units (about 12 MB of slots), or if
  views grow to hundreds of thousands of rows each, store a unit as `Uint32Array` of page numbers plus its bitmap and turn ids into
  strings only for the window: 30 times smaller than strings, and `ViewState`'s consumers are few (`live.ts`, `view-unit.ts`).
- **`maintain` grows with touched units x candidates.** One hot write touching 50 units costs 17 ms at 20,000 pages. A write that
  touches 500 distinct filtered views or a batch of hundreds of pages (an import) pays seconds: past about 200 distinct open views
  per workspace, group units by the properties they read and evaluate once per group, or batch the tuple loads of
  `maintainView`'s binary search.
- **A single thread serves about 1,000 requests per second**; fan-out to 1,000 tabs is 1,000 sends per commit. At the measured 24 ms
  fan-out for 40 sockets, 1,000 sockets is dominated by `send` and `head` frames: the governor (below) exists for that.
- **SQLite 5 GB** is the alert (limit 10 GB); shard by type or tag (docs/PLAN.md) from there.
- **Option index** rebuilds cost one scan per property per wake; if a workspace has properties with 10,000 distinct values (person
  properties in a company-wide directory) persist the bitmaps in a table with `applied_seq` instead.

## The overload runbook, implemented (docs/PLAN.md "Runbooks")

"Workspace DO overloaded: stop re-evaluating subscriptions of hidden tabs, widen batching, and alert; never drop writes."

- `LoadGovernor` (`governor.ts`): overloaded when the average commit-and-fan-out time (queue wait included) passes 150 ms (the
  edit-to-diff target) or six tasks wait behind the running one; it holds for 30 s. `liveStats().governor` shows it; `forceOverload(ms)`
  forces it for tests and operators.
- **Hidden tabs**: the client sends `{ t: 'visibility', hidden }` (`document.visibilitychange`, and in `hello` when it connects hidden).
  While overloaded, the fan-out neither derives nor sends anything to a hidden socket and marks it stale; on `hidden: false` a stale
  socket (or one the object woke up holding) gets `resumed` (snapshot mode) and a fresh snapshot of every subscription
  (`WorkspaceSocketApi.resync`). Not overloaded, a hidden tab is served like any other.
- **Wider batching**: while overloaded, a commit that only wrote property values and has more work queued behind it does not fan
  out; the last task of the queue sends one merged fan-out (rows in order, the last `seq`), so a socket receives one diff for
  several commits. Commits that change structure, definitions or access are never merged. Every write is committed and answered
  at once; only the pushes are shared. The test fires 30 concurrent writes and checks every socket ends equal to a fresh query.
- **Alert**: a console error and an `error` metric labelled `overload` (at most one per minute); the SLO alert cron reads metrics.

## Limits and warnings

- **Location hint** (`location.ts`): `createWorkspace` derives a hint from `request.cf` (continent, country, longitude: `wnam`,
  `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`), puts it in the `init` outbox row, and the first `getByName` of the object
  passes it (later calls do not: Cloudflare keeps the first placement). No `cf` (dev, tests) means no hint.
- **5 GB storage alert**: the hourly gauge writes the `storage` metric (the SLO alert reads it, `admin/slo.ts`); at 5 GB it also logs an error
  and writes an `error` point labelled `storage-alert`, and an object over 1 GB keeps its hourly alarm even when idle (it used to stop
  once the change log was empty).
- **80% of the document quota** (edytor's 16 MiB limit): the Page DO reports to the Workspace DO when a save moves the share across 80% or
  by five points past it; the Workspace DO keeps it in `meta` and pushes `{ t: 'quota', pageId, bytes, limit }` to tabs that can read the
  page (and to tabs that connect later, with their `hello`); the store shows one toast per page per five points ("This page is nearly
  full"). The room's `doc_size` metric is unchanged.

## What the staging load test found (P4 gate)

The first run of `docs/ops/load-test.md` against staging (1,000 tabs, 20 writes a second) failed on every target: edit-to-diff p50 16.8 s, 938 of 1,201 writes answered
500 ("Durable Object is overloaded. Requests queued for too long."), cold first window 995 ms. The local profile above had measured 40 to 56 ms of fan-out for the same shape,
so the gap was in what the profile did not exercise. Causes, with the evidence for each (`wrangler tail`, a CPU profile of `wrangler dev`, and counters in the live loop):

1. **O(sockets) per commit and per await, in the object** (the 500s). The fan-out looked up each socket's actor with `deserializeAttachment` (a structured clone) through a map
   that was rebuilt every microtask turn, so every `await` of a derivation re-read all 1,000 attachments; a commit also read them all again to settle the actors, read
   `socket_stream` and joined `sub_link` (8,000 rows) in SQL, and built a signature string per tab. The object spent 40 ms of CPU per commit at 200 tabs (tail `cpuTime`,
   p50 40 ms; wall 377 ms with the queue), 20 commits a second saturated it, workerd shed the calls. **Fix:** `socket-directory.ts` (sockets and actors in memory, read once per wake),
   the stream set and the audiences in memory, and `LiveHub.#fanOut` iterates audiences, not (socket, subscription) pairs: 40 ms to 4.4 ms of fan-out at 1,000 sockets on the same
   profile (`derive` 33 ms to 0.85 ms), 14 ms of CPU per commit on staging at 200 tabs.
2. **A derivation per commit even when nothing moved.** A cell edit re-cut every touched view's window for every person (two windows, a set of ids, intersections). The window of an
   unchanged unit is now derived once per (unit state, visibility revision, window size) and looked up by the edited pages (`#windowIndex`); snapshots are cached per
   `seq` (a reconnect storm of 1,000 tabs cost 1,000 x 10 snapshots at 1 to 3 ms each).
3. **A write waited for its own fan-out and the object answered "overloaded" with a 500.** Now a 503 `SERVICE_UNAVAILABLE` that the store retries with the same `mid`.
4. **The Worker's per-write overhead.** `mutate` and the socket upgrade each made a Durable Object call (`getMemberRole`) before the real one, queued behind the commits they then
   waited for; the load test's cookies had no `session_data` cache and read D1 on every call (tail: session 50 to 60 ms, membership 20 to 45 ms of every dial). The role is now resolved
   inside the call to the object (D1 only on a miss) and the minted cookie carries the cache, as a signed-in tab's does.
5. **Dial latency is the size of the script** (docs/ops/load-test.md "Start-up"): 75 ms per MB, on every WebSocket upgrade.
6. **The client was part of the result.** One Node thread could not take 20,000 frames a second, and past a few hundred connections the laptop's own connection stalls (a plain GET took
   857 ms at p50 with 1,000 idle connections open). The tool now spreads the sockets over threads (`ws`), prints its own round trip, and `inside.ts` runs the tabs from Workers.

A hypothesis that did not survive: a ceiling of about 8,500 frames a second per object, measured with a bench that only sent. It was the client path; from inside Cloudflare one object
delivers 15,000 frames a second to 1,000 tabs with no queue, so the egress budget that was built on it was removed.

## Second pass: the 1,000-tab p95, socket shards, cold start

The first pass left the edit-to-diff p95 at 179 to 423 ms from inside Cloudflare (target 150) and the cold first window at 450 to 700 ms (target 300). This pass
measured where the tail comes from before changing anything, then changed what the measurements pointed at. Tools: `scripts/load/inside.ts` (new flags and lines, see
`docs/ops/load-test.md`), and throwaway RPCs on the Workspace DO (removed again) whose CPU time was read from `wrangler tail`, because `Date.now()` and
`performance.now()` do not advance inside synchronous code on Cloudflare, so a phase timer inside the object reads zero.

### What the measurements say

| | measured on staging |
| --- | --- |
| Where the object runs | A different data center almost every run (MXP, CDG, FRA, LHR, MRS) and so is each shard. The same JavaScript costs 236 ms on the laptop, 555 ms on an MXP host and 857 ms on an MRS host: **hosts differ by 1.5x to 2.5x**. |
| CPU of one `setProp` commit, 10 tabs | 9 to 11 ms on a fast host, 19 to 25 ms on a slow one (`wrangler tail`, `cpuTime` of 100 commits back to back). One ORM read is 0.14 to 0.4 ms, one raw statement 34 microseconds. |
| Where that CPU goes (10 tabs, 8 views) | Preamble (client, registry, validation) 0.03 ms; an empty commit 1.2 ms; authorization 1 to 1.5 ms; the op and the commit's own rows about 3 ms; **the fan-out (view maintenance 3 to 8 ms, derivation 2 to 6 ms, sends about 0) is 70 to 75% of the CPU**. Nothing in it dominates. |
| Storage | `storage.sync()` after a write takes 17 to 22 ms (the output gate holds every frame and the RPC answer for that long). An async `storage.transaction()` does not wait for it (0 ms), so the commit queue is not held by storage. |
| Delivery alone (`--echo`: a bare `head` to 1,000 tabs, no commit, no gate) | One object holding every socket: p50 34 / p95 98 ms (object in MXP) and 86 / 222 ms (object in MRS, the data center the load generators run in). Four shards: p50 14 / p95 50 ms. So delivering 1,000 frames from one thread is worth about 50 ms at p95 on its own. |
| A call between two objects | 15 to 19 ms round trip, even when both run in the same data center. A shard adds that hop to every frame it sends. |
| Frames held by the object itself vs by a shard (1,000 tabs, 20 writes/s) | Object: p50 8 to 44 ms. Shard: p50 59 to 103 ms. The shards of one workspace land in different data centers (FRA, MXP, MRS, CDG, LHR in the same run), so their latencies differ by 30 ms and the slowest decides the tail. |
| Capacity of the commit thread | 10 tabs: 30 writes/s is fine (p95 81 ms), 40 to 60 writes/s on a slow host queues for seconds (`Durable Object is overloaded`). At 1,000 tabs and 20 writes/s a slow host is already past what it sustains: **about a quarter to a third of the runs of this pass saturated completely** (commit call p50 of seconds: 5 of 22 with shards, 2 of 6 without). |

In short: the p95 is the sum of a commit that costs 10 to 25 ms of CPU on one thread, a 20 ms durability wait before any frame leaves, one or two 8 ms hops, and the
fan-out of 17,000 frames a second. On a fast host that fits in about 150 to 180 ms at p95 (best runs: 157 and 165 ms with shards, 182 ms without); on a slow one the thread is saturated at 20
commits a second. The remaining work is in the commit and the view maintenance themselves (hundreds of ORM calls and policy snapshots per second), not in the sends.

### What changed

- **`SocketShardDO`** (`socket-shard.ts`, `shard-router.ts`; the plan's "a workspace that outgrows one object shards ..." applied to fan-out). The Workspace DO stays the single source of
  truth for writes, subscriptions, windows, presence and visibility; a shard holds a share of the hibernatable sockets and does the `ws.send` loop. Past `SOCKET_LOCAL_MAX`
  sockets (default 48; small workspaces never leave the object) a dial is forwarded to the least loaded of `SOCKET_SHARDS` shards (0 = off; also `configureShards`, stored in `meta`).
  Client frames go to the Workspace DO through `shardFrame` (pings are answered by the shard), the Workspace DO sends **one batch per shard per turn** (`push`: `[text, [socket ids]]`
  entries, so a commit's frame, encoded once, is listed once with the sockets of that shard), and a shard tells it when a socket closed (`shardClosed`). Order: one batch in flight per shard,
  what accumulates leaves together; one frame in flight per socket from the shard. Hibernation: the shard keeps nothing but the sockets and their attachments (`{ socketId, shard, actor }`);
  the Workspace DO records its remote sockets in a `shard_socket` table and rebuilds them (and `RemoteSocket` facades with the same surface as a `WebSocket`, so the live loop, the oRPC
  transport and the access code do not know the difference) when it wakes. Role changes, removals, renames and `resync` reach shard sockets through the same `close` and
  `serializeAttachment`. The shards are placed in the region the workspace was created with (`init` stores the hint). `wrangler.jsonc` has a `v2` migration with `SocketShardDO`
  (environments inherit `migrations`; each environment also lists them), `wrangler.test.jsonc` too.
- **Tests**: `tests/workers/socket/shards.test.ts` (placement, order, closes, role change, removal, oRPC `hello`, hibernation of both sides) and
  `tests/workers/live/fuzz-shards.test.ts` (the live fuzz with every socket held by 3 shards, evicting the Workspace DO and the shards; 60 seeds passed, the plain fuzz 40).
  `pnpm exec playwright test` P1 and P3 gates pass with `SOCKET_SHARDS=2 SOCKET_LOCAL_MAX=0` in `.dev.vars` (every socket on a shard).
- **The policy client is built once per set of actor facts** (`AccessService.governed`; `$as(facts)` snapshots the facts and wraps every model: it was about half of `apply`'s CPU in a
  local profile) and **a commit's transaction is handed the property registry** (`primeRegistry`: each transaction object is new, so each op read the property table again through the
  policy's client). In production this took a commit from 10.5 to 9.3 ms (fast host); the local profile had promised more, and a profile taken through the inspector inflates allocation-heavy code.
- **Fan-outs merge whenever work waits behind the commit**, not only when the governor says overloaded (value-only commits; `mergeCommits`): writes that cluster cost one derivation and one frame per socket.
  `inside.ts` judges the p95 on the stricter of "frames for exactly this write" and "diff frames including merged ones".
- Not done: answering the RPC before the fan-out (it would not move the collaborators' latency: the answer and the frames wait for the same storage confirmation); value-only diffs are already
  one `update` op per cell; heads are already withheld past 64 recipients (the writer's tabs excepted).

### Cold first window

`run.ts` cold probes against staging after this pass: first window p50 593 to 674 ms, max 745 to 997 ms (`dial to open` 530 to 600 ms, `hello to snapshot` 65 ms). The server side of a
dial (the Worker's event 120 to 150 ms of CPU on a fresh isolate, the object's wake 35 to 66 ms of CPU) is a third of it. The rest is isolates starting: a WebSocket upgrade that the Worker
answers by itself (`/healthz` with `Upgrade: websocket`, no object involved) takes 335 to 607 ms on staging against 140 to 190 ms for a plain request, and the object's own isolate pays the same
parse of the same 5.6 MB script when it is cold. A front Worker is excluded, and the script is one bundle (`_user-worker.js` 7.3 MB before minification: 2.9 MB of entasis, 0.5 MB of charts,
the SvelteKit server and the rest of the rendering of the app, although the app's routes have `ssr = false`). **300 ms from a cold object is not reachable with this script**: even a
perfect object wake leaves about 350 ms of Worker isolate start-up plus four client round trips. What would get there: a script whose `/ws` path is a few hundred kilobytes (the app's
server rendering and the Durable Object implementations loaded as separate modules on first use: a change of the build, not of the code), measured at 66 to 100 ms for a 1 KB script in the first pass.

## Deviations

- The plan expected bitmaps "keyed per (prop, option) ... persisted or rebuilt on wake" for the engine and the live loop: the option index
  is that, rebuilt on wake; the larger win came from view-membership and visibility bitmaps, which are not keyed by option.
- `roaring-wasm` needs a patch and a build step (above); a package that ships a precompiled-module entry point would not.
- `engine/sources.ts` (the Databases track's) got the materialized probes; its API is unchanged.
- Protocol additions: client `visibility`, server `quota`.
- Fan-out sharding (second pass): the plan shards the property index by type or tag when a workspace outgrows one object; here the object stays whole and only its sockets are sharded
  (`SocketShardDO`, "Second pass" above), because the measured limit was the delivery of 17,000 frames a second, not the data. Off by default (`SOCKET_SHARDS`), on in staging: it cut the delivery
  of a bare fan-out by half at p95 but its hop, and the data centers the shards land in, cost as much in the p95 of real writes, so it is not turned on in production.

## Third pass

Commit statements (107 to 38 for a value write that touches views), the output gate, the split script and the cold dial: `docs/ops/load-test.md` "Third pass". Targets still not met (best p95 182 ms, cold window 545 ms, saturated runs on slow hosts).
