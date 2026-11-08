# Load test

Scripted sockets and writes against staging (docs/PLAN.md "Testing, observability and operations: Load"). It
validates the three targets of "Performance, limits and scaling":

| Target (plan) | Measured as | Pass line |
| --- | --- | --- |
| A property edit reaches collaborators within 150 ms at p95, same region | `edit-to-diff minus client RTT` p95 (the raw line is printed too) | `--p95-ms`, default 150; `--raw` judges the raw line |
| A view's first window renders within 300 ms from a cold object | `cold dial to first window` max | `--cold-ms`, default 300 |
| One workspace serves 1,000 concurrent tabs | `tabs: connected` with `--tabs 1000`, and the two lines above while they are connected | no tab fails to connect |
| Workspace socket reconnects below 1% of sockets per hour (operating targets) | `reconnects` percent per hour | 1 |

Code: `scripts/load/run.ts` (the CLI), `scripts/load/tabs-worker.ts` (the threads that hold the sockets) and `scripts/load/lib.ts`;
`scripts/load/inside.ts` runs the same scenario with the tabs opened from inside Cloudflare (below); the test auth is
`src/server/auth/load-test-auth.ts` (guard: `load-test-guard.ts`; the probe: `load-test-inside.ts`).

## How it works

1. **Test auth.** There is no passkey UI in a script, so the Worker has a staging-only endpoint family,
   `POST /api/load-test/{users,workspace,cleanup,inside}`. It answers a plain 404 (like a path that does not exist) unless
   **all** of these hold: `env.ENVIRONMENT === 'staging'`, the Worker secret `LOAD_TEST_KEY` is set and is at least 24
   characters, and the request carries `x-load-test-key` equal to it (constant-time comparison). Production and the
   test environment can never qualify, whatever the secret (`tests/unit/auth/load-test-guard.test.ts`,
   `tests/workers/scale/load-auth.test.ts`). The one other case is local smoke: `ENVIRONMENT === 'development'`
   with the key in `.dev.vars` and a request to localhost, 127.0.0.1 or [::1].
   - `users { runId, count }` creates synthetic users `load-<runId>-<n>@load.invalid` (email verified, no passkey,
     the reserved `.invalid` domain cannot receive mail) and a real better-auth session each, and returns the signed
     session cookie. `/rpc`, `/ws/:id` and `/rooms` accept it like a browser's. At most 200 users per call.
   - `workspace { ownerId, memberIds, name }` runs the real create-workspace path (D1 rows, membership outbox,
     Workspace DO `init`) for the first user and adds the others as members the way accepting an invite does.
   - `cleanup { runId }` wipes the Workspace DO storage of the run's workspaces and deletes their D1 rows and the
     synthetic users (sessions cascade). It only touches workspaces that have a `load-<runId>-*@load.invalid` member.
2. **Seed.** A database with `--rows` rows (a number, a select `prio`, a checkbox and a text property) through the
   real `/rpc/mutate`.
3. **Tabs.** `--tabs` sockets are opened in batches of `--ramp-batch` every `--ramp-delay-ms` (no thundering herd),
   spread over `--users` users. Each is a raw protocol socket (`/ws/:id?v=<app version>`, the user's cookie and
   `Origin`), sends `hello` and subscribes to the tree, the database page and `--views` shared views (a sorted table, a
   board grouped by `prio`, filters on `done`, `amount` and the hot property `prio`). A dropped socket reconnects
   with its `lastSeq`, as the app does. The sockets live in **worker threads** (`--procs`, by default one per 125 tabs, at most
   8; `tabs-worker.ts`) and use the `ws` package: one Node thread with undici's WebSocket cannot parse 20,000 frames a second, and
   a client that cannot keep up reports its own queue as latency (the first 1,000-tab run on staging was 25 s of that and of an
   overloaded object, indistinguishably). The cookie a user holds is what a signed-in tab holds: the session token **and**
   better-auth's `session_data` cache (`withCookieCache` in `load-test-auth.ts`), so `/rpc` and `/ws` check a signature instead of
   reading D1.
4. **Writes.** For `--duration` seconds, `--writes-per-sec` random edits (35% `amount`, 35% `prio`, 15% `done`, 10%
   text, 5% creates) go through `/rpc/mutate` on an open loop (a write is sent on schedule even if the previous one
   is slow, so queueing shows up as latency). Each write's `seq` comes back in the response.
5. **Latency.** For every (write, tab) pair: the time of the tab's own `diff` frame for that `seq`, minus the time the write was
   sent (`edit-to-diff`); when the tab got no frame of its own (the commit touched none of its views) the time of the first frame
   whose `seq` is at or past the write's (`edit-to-head`: since the object batches plain heads past 64 recipients, a later head or
   diff stands for it, and the writer's own tabs get theirs at once). A pair no frame covers by the end is `missing`. Arrivals within
   1.5 s of a (re)connection are ignored (replays). The tool also measures **its own distance to the edge**: 30 sequential GETs of
   `/healthz` on a kept-alive connection (`client round trip`); every edit-to-diff sample carries that round trip once (the write
   goes to the edge, the frame comes back from it), so the line `edit-to-diff minus client RTT` is what a collaborator in the
   same region would see, and the raw line is what this client saw. The verdict uses the adjusted line unless `--raw`.
6. **Cold first window.** Before any tab connects, `--cold-probes` extra workspaces are created and seeded
   (`min(rows, 500)` rows) and left with no sockets and no calls. After `--cold-idle` seconds (default 20, longer than
   the time Cloudflare keeps an idle object in memory) each is dialled with a new socket, one at a time, and the time from
   dialling to the first view snapshot is recorded. A fresh dial of an idle object is the cold case: the wake
   (constructor, migrations check, visibility set) happens during the upgrade, so it shows in `dial to open`;
   `hello to snapshot` is the view's first evaluation. Eviction cannot be forced or observed from outside, so
   treat the idle wait as "very probably cold"; raise `--cold-idle` to 60 for more certainty.

## Run it against staging

One-time setup (the orchestrator; needs the Cloudflare account):

```sh
# 1. A random key of 24+ characters; it never goes in the repo.
export LOAD_TEST_KEY="$(openssl rand -hex 24)"
printf '%s' "$LOAD_TEST_KEY" | pnpm exec wrangler secret put LOAD_TEST_KEY --env staging

# 2. The code must be deployed to staging (it contains the test-auth route and the guard).
pnpm run deploy:staging
```

Smoke first (10 tabs, 2 users, 50 rows, 10 s), then the full run:

```sh
pnpm load:smoke --base https://flarion-staging.beynar.workers.dev --key "$LOAD_TEST_KEY"

pnpm load --base https://flarion-staging.beynar.workers.dev --key "$LOAD_TEST_KEY" \
  --tabs 1000 --users 25 --rows 500 --views 8 --writes-per-sec 20 --duration 60 \
  --cold-probes 5 --json load-1000.json
```

Heavier variations: `--rows 5000 --views 24` (more units, bigger windows), `--writes-per-sec 100`
(commit throughput), `--tabs 250` (a baseline to compare 1,000 against). `--no-assert` always exits 0, `--no-cleanup`
keeps the workspace for inspection (clean it later with the same `--run-id`, see below).

When finished, remove the secret so the route is shut again:

```sh
pnpm exec wrangler secret delete LOAD_TEST_KEY --env staging
```

Run it from a machine in the same region as the staging colo for the 150 ms target to mean what the plan says: a
laptop on another continent adds its round trip to every sample (the script measures from the client, as a tab
does; it prints that round trip and the numbers minus it). **Do not trust a run from a home or office connection past a few hundred
sockets**, whatever the CPU: with 1,000 idle keep-alive HTTPS connections open to the edge from the machine these tests were developed
on, a plain `GET /healthz` took 857 ms at p50 (15 ms with 200 open) and opening them took 78 s instead of 3, while the Worker's own
side of the same writes was 54 ms (`wrangler tail`). For 1,000 tabs use `inside.ts` (below), or a VM in the colo.

### Measuring from inside Cloudflare

```sh
node --experimental-strip-types scripts/load/inside.ts --base https://flarion-staging.beynar.workers.dev \
  --tabs 1000 --users 25 --rows 500 --views 8 --writes-per-sec 20 --duration 20 --procs 8
```

Same users, workspace, seed, subscriptions and writes as `run.ts`, but the tabs are opened by Workers of the target
(`POST /api/load-test/inside`, `src/server/auth/load-test-inside.ts`: staging only, same guard and key, and only for a workspace of
synthetic users) as WebSocket clients of the Workspace Durable Object, so no client network is in the numbers. `--procs` follower
calls (isolates; 125 tabs each) hold the tabs and report every frame they received, a leader call with no tab commits the writes with
a call to the object (what `/rpc/mutate` does after authenticating) and the script matches them. What it leaves out: the HTTP write
path (Worker, session, membership), the client's network and cold probes; what it adds: the probe's own isolates (a few ms of timer
and clock granularity, and their CPU: at 200 tabs it reads about 50 to 90 ms above what a laptop measures at p95).

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base` | `http://localhost:5173` | Origin of the target |
| `--key` | `$LOAD_TEST_KEY` | Test-auth key |
| `--tabs` / `--users` | 1000 / 25 | Sockets, and how many distinct users they are spread over (a user's cookie may hold many sockets) |
| `--rows` | 500 | Rows in the seeded database |
| `--views` | 8 | Shared views each tab subscribes to (5 fixed shapes, then filters on `prio` and `amount`) |
| `--writes-per-sec` / `--duration` | 20 / 60 | Write rate and the length of the write phase, seconds |
| `--cold-probes` / `--cold-idle` | 5 / 20 | Cold first-window probes, and the idle seconds before each is dialled |
| `--ramp-batch` / `--ramp-delay-ms` | 50 / 250 | Tabs opened per step and the pause between steps |
| `--p95-ms` / `--cold-ms` | 150 / 300 | The targets the exit status is judged against |
| `--procs` | 1 per 125 tabs, at most 8 | Worker threads holding the sockets (`run.ts`), or follower calls (`inside.ts`) |
| `--raw` | off | Judge `edit-to-diff` on the raw line instead of minus the client round trip |
| `--json file` | none | Writes every number below as JSON |
| `--run-id` | random | Names the synthetic users (`load-<id>-<n>`); pass one to clean it up later |
| `--no-assert`, `--no-cleanup`, `--smoke` | | Always exit 0; keep the data; the small preset |

Clean up an earlier run (a crashed run leaves its workspace): `curl -sX POST -H "x-load-test-key: $LOAD_TEST_KEY"
-H 'content-type: application/json' -d '{"runId":"<id>"}' https://flarion-staging.beynar.workers.dev/api/load-test/cleanup`.
Synthetic data is recognisable by the `@load.invalid` addresses and the workspace names `Load <runId>` and
`Cold <runId> <n>`; nothing else is ever deleted by the endpoint.

## Reading the output

```
tabs        requested 1000, connected 1000, failed 0, connect retries 0, ramp 24.3 s
dial to open                   ...   Worker + auth + object wake, per tab
hello to last snapshot         ...   first windows of all subscriptions (the ramp's load shows here)
write round trip (HTTP)        ...   /rpc/mutate: commit time plus network
client      8 threads, warm round trip to the edge p50 ... p95 ...   this machine's own distance to the edge
edit-to-diff (raw)             ...   frames that carry a change a socket's views show, as this client saw them
edit-to-diff minus client RTT  ...   THE TARGET: the same minus one client round trip (what a same-region collaborator sees)
edit-to-head (no change here)  ...   sockets whose views the write did not touch: the first frame at or past its seq
edit-to-any-frame              ...
reconnects  ... % of sockets per hour
cold dial to first window      ...   the 300 ms target
errors      none
```

- **edit-to-diff** is the plan's "edit to collaborator diff". `n` counts (write, tab) pairs. `deliveries missing` is
  the number of (write, tab) pairs no frame at or past the write's `seq` ever reached (a later `head` or `diff` stands for one an
  earlier commit's frame was merged into): anything above 0 is a bug or a dropped socket.
- **edit-to-head** is not a target: a socket whose views a write does not touch only needs a `head` to advance its `seq`. Past 64
  such sockets the object batches heads (up to 250 ms; the writer's own tabs get theirs at once), so this line is a floor of how
  late a bystander's `seq` is.
- **Saturation looks like this**: write round trip and edit-to-diff growing together to seconds. The Workspace DO runs
  commits and their fan-out one at a time, so a write rate above what one commit costs (commit plus work per
  socket and per touched view) queues. Lower `--writes-per-sec` to find the knee; it is the number the scaling
  decision (docs/spikes/p4-scale.md) is made from.
- **errors** are counted by kind: `write_failed`, `error_frame:*` (a protocol `error`), `ws_closed:<code>` (an
  unexpected close; `4503` is the object asking for a resync), `tab_failed_to_connect` (three failed attempts),
  `cold_probe_failed`, `cleanup_failed`. Any entry fails the run.

Exit status: 0 when every target is met, 1 when one is missed (the `MISS:` lines say which), 2 on a fatal error
(for example the test auth answering 404: the secret is not set, the deploy is older than this code, or `--key` is
wrong).

## What the server does under this load

Read together with `docs/spikes/p4-scale.md` (the profile this run is the staging counterpart of):

- **Bitmaps.** The Workspace DO answers filters and counts from Roaring bitmaps when `roaring.wasm` loaded. The first deploy that
  carries it must be checked: `wrangler tail --env staging` should NOT print `[bitmaps] roaring-wasm is unavailable`. If it does, the
  run still works on the SQL paths (slower at 1,000 tabs: see the "SQL paths" columns of the spike) and the cause is the module
  packaging (`scripts/postbuild.mjs`, `find_additional_modules` in `wrangler.jsonc`). `BITMAPS=off` as a Worker var turns them off
  to compare.
- **Overload governor.** Past 150 ms average commit-and-fan-out (or six tasks queued) the object logs
  `[workspace] <id> is overloaded`, writes an `error` metric labelled `overload`, stops serving hidden tabs (the load script's
  tabs are never hidden, so this does not show in its numbers) and merges the fan-outs of queued value-only commits: the script
  then sees fewer, later diffs for the same writes, `edit-to-diff` rises and nothing is lost (`deliveries missing` stays 0).
  A run that trips it shows the write rate above what one thread sustains; lower `--writes-per-sec` for the knee.
- **Audiences.** The 1,000 tabs of `--users 25` are 25 people with the same subscriptions: the server derives one diff per person and
  view shape per commit, builds one frame per audience (sockets with the same actor and the same subscriptions), encodes it once and
  sends the same string on every socket of it. The window of a view unit is derived when the unit, the person's visibility or the window
  size changes; a commit that only edits cells of it looks the edited pages up in a cached index. Snapshots (a reconnect storm) are cached
  per `seq`, visibility and shape. A run with `--users 400` is the case without sharing (about 16x the derivations); use it as the stress
  variant.
- **Heads.** A commit that touches none of a tab's views owes it only a `head`; past 64 such tabs the object sends them with the next batch
  (250 ms), and the committing person's tabs at once (they drop their optimistic layer on it). The client advances `seq` on any frame, so a
  later one stands for an earlier head.
- **A busy object is a 503, not a 500.** When workerd answers "Durable Object is overloaded" the Worker maps it to 503 `SERVICE_UNAVAILABLE`
  and the store sends the same mutation (same `mid`, so safe) again, up to four more times. Writes are never dropped.

## Local smoke

`pnpm dev` runs `ENVIRONMENT=development`, which the test auth honours on localhost only, with
`LOAD_TEST_KEY` (24+ characters) in `.dev.vars`:

```sh
echo 'LOAD_TEST_KEY=local-load-test-key-0123456789abcdef' >> .dev.vars
pnpm exec vite dev --port 5981 &
pnpm load:smoke --base http://localhost:5981 --key local-load-test-key-0123456789abcdef
```

Local numbers share one machine between the server, the object and the script, and the dev proxy is not the
edge: they prove the tool works, not the targets.

## Start-up: why a dial costs what it costs

A request with `Upgrade: websocket` is served by a fresh isolate that loads the whole script; a plain request reuses a warm one. Measured on staging
(same Worker name, `curl --http1.1`, from France, 6 requests each, `time_starttransfer` after the TLS handshake):

| What was deployed | `/healthz` plain | `/healthz` with `Upgrade: websocket` | `Worker Startup Time` |
| --- | ---: | ---: | ---: |
| the app as it was (10.5 MiB, eager) | 15 ms | 410 to 420 ms | 156 ms |
| a 1 KB stub | 15 ms | 66 to 100 ms | 5 ms |
| the stub plus 6 MB of dead code in the same module | | 490 to 590 ms | 35 ms |
| the stub plus 6 MB in a module nothing imports (`no_bundle`) | | 235 to 320 ms | 5 ms |
| the app, routes and SvelteKit imported lazily (11.1 MiB) | | 305 to 490 ms | 79 ms |
| the same, minified (5.6 MiB) | 15 ms | 295 to 357 ms | 60 to 100 ms |

So a socket dial pays about 75 ms per MB of script (the parse of a module, half of it again for one that is only present), plus the module
evaluation, plus the 75 ms of a stub: **the floor of a dial through this Worker is its size, not its work**, and `Worker Startup Time` is only
part of it. What the repository does about it: `src/worker.ts` imports no route (each handler is `import()`ed on its first request), SvelteKit is
loaded the same way (`scripts/postbuild.mjs` rewrites the generated `_worker.js`), the Workflows are thin classes that import their implementation when a run
starts, `auth/session.ts` loads better-auth on first use, `wrangler.jsonc` minifies (`keep_names` stays on) and uploads source maps. `wrangler check startup`
(local profile, `Active` ms: 55 to 65 before, 33 after) and the `Worker Startup Time` of `wrangler deploy` show whether a change put weight back.

What is left: the script carries the server rendering of the whole app (entasis, charts, every page: about 40% of it), the query layer and the editor.
Further down means splitting what a socket dial loads from what the app renders: a front Worker for `/ws`, `/rpc` and the Durable Objects with the
SvelteKit app behind a service binding (a design decision for the orchestrator: it adds a Worker and a deploy). The dial is also cheaper when an isolate is
already warm: with other tabs connected, the cold probes measured 112 to 186 ms to open; with nothing warm, 450 to 700 ms.

## Results

Staging, `https://flarion-staging.beynar.workers.dev`, from France (Cloudflare colo MRS, warm round trip to the edge 14 to 20 ms, TCP connect 16 ms).
`edit-to-diff` is raw, then minus the client round trip. "In-DC" is `inside.ts`.

| Date | Build | Tabs | Writes/s | Rows / views | Client | edit-to-diff p50 / p95 / p99 | Write round trip p50 / p95 | Failed writes | Missing | Cold first window |
| --- | --- | ---: | ---: | --- | --- | --- | --- | ---: | ---: | --- |
| 2026-11-08 | before (orchestrator) | 10 | 5 | 50 / 5 | laptop | 166 / 232 / 554 ms | 178 / 379 ms | 0 | 0 | 970 ms |
| 2026-11-08 | before (orchestrator) | 1,000 | 20 | 500 / 8 | laptop | 16.8 s / 24.9 s | 10.8 s / 17.4 s | 938 of 1,201 (500) | 1,163 | 995 ms max |
| 2026-11-08 | before | 200 | 20 | 500 / 8 | laptop | 1,443 / 2,599 / 3,178 ms | 1,388 / 2,522 ms | 0 | 0 | |
| 2026-11-08 | final | 10 | 5 | 50 / 5 | laptop | 63.5 / 95.9 / 111 ms (minus RTT 17.3: 46 / 78 / 94) | 68 / 100 ms | 0 | 0 | 522 ms (nothing warm); 164 ms in the run before it |
| 2026-11-08 | fixes, before the last two | 200 | 20 | 500 / 8 | laptop | 71 / 113 / 148 ms (minus RTT 17.6: 54 / 95 / 130) | 72 / 115 ms | 0 | 0 | |
| 2026-11-08 | same | 200 | 20 | 500 / 8 | laptop | 64 / 164 / 412 ms (minus RTT 20: 44 / 144 / 392) | 64 / 163 ms | 0 | 0 | 466 ms (nothing warm) |
| 2026-11-08 | same | 1,000 | 20 | 500 / 8 | laptop | 12.8 s to 17 s: not measurable (the 1,000 connections stall this client) | 5 s to 14 s; 503 "busy" on 627 of 1,200 in the last run | up to 627 | | 237 ms (max 264; open 164, hello 71) in one run, 5.2 s in the last |
| 2026-11-08 | final | 1,000 | 20 | 500 / 8 | in-DC | 71 to 97 / 179 to 423 / 242 to 822 ms (five runs) | commit call 96 to 111 / 200 to 426 ms | 0 of 600, five runs | 0 | |

The server side of the 1,000-tab runs, whatever the client saw: the Worker's `/rpc/mutate` took 54 ms at p50 and 190 ms at the maximum (`wrangler tail`, a 1,000-tab run at 5 writes a second), a
commit with its fan-out to 1,000 tabs (15,000 frames a second from inside) leaves no queue behind it, and the object's CPU per commit at 200 tabs went from 40 ms
(before) to 14 ms. The 150 ms line holds at p95 at 200 tabs from a laptop (95 ms minus the round trip) and at 10 tabs; at 1,000 tabs and 20 writes a second
every write touches 87% of the tabs (17,000 frames a second), and from inside Cloudflare the p95 is 179 to 423 ms with a p50 of 71 to 97 ms: the object keeps up (no failed write, nothing
missing, no queue), it is not under the line. What is left in a commit is the write itself (a 200-tab commit is 57 ms of wall for 14 ms of CPU, most likely the output gate holding
every frame until the storage write is confirmed) plus the fan-out's CPU, several times a laptop's on this runtime (`ws.send` itself is cheap: 5,000 sends in one call added under 25 ms).
The p95 differs by run (neighbours, where the object was placed): compare runs of the same day, several of them.

**The laptop run of 1,000 tabs did not pass, and it is not only the laptop.** From this machine the same 1,000 sockets stall every request (a `GET /healthz` at p50 857 ms with 1,000
idle connections open), and in the runs that wrote 20 times a second the object also answered 503 "busy" for hundreds of writes (none in any in-DC run, where the sockets read as fast as the
object writes). So a workspace whose tabs read slowly is a load the object feels, and the live loop has no protection against a slow consumer (workerd exposes no `bufferedAmount`
on a server socket, so the object cannot see one): see "What is left".

## What is left

- **The 150 ms line at 1,000 tabs and 20 writes a second** is 179 to 423 ms at p95 from inside Cloudflare (p50 71 to 97 ms). Candidates, in order of what they would buy: a second object that
  holds a share of the sockets and receives each commit's frames to send (the fan-out's CPU divides, the commit's cost does not); fewer frames per commit (a view that touches 87% of the
  tabs per write is this test's choice, not a property of the product); a front Worker for `/ws`, `/rpc` and the objects without the SvelteKit app (the dial).
- **Slow consumers.** An acknowledged `seq` in the client's `ping` would let the object skip a tab that lags by hundreds of commits (it would be marked stale and resynchronized like a hidden
  tab of an overloaded object, `WorkspaceSocketApi.resync`) instead of queueing frames toward it.
- **The cold first window** is 164 to 264 ms when an isolate is warm (any tab connected or a dial a moment ago) and 450 to 700 ms when none is: the floor is the script's size (above).
- `roaring.wasm` is instantiated by every object wake (`ensureRoaring` in the constructor); making it lazy would save a few milliseconds of a cold wake and was not worth the risk of mixed modes.

Local smoke on the development server, for reference (2026-11-08, 10 tabs, 5 writes/s, 5 views, 50 rows): edit-to-diff
p50 11.5 ms, p95 24 ms; cold first window 17 ms.
