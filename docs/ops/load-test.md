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

`inside.ts` also takes `--shards N --local M` (how many socket shards and how many sockets the Workspace DO keeps for itself, set before the tabs dial: `--shards 0` is
the single-object path), `--echo N` (instead of writes, N bare `head` frames to every tab: the delivery alone, no commit and no storage wait; read the `edit-to-head` line) and the
environment variable `LOAD_TIMELINE=1` (a line per two seconds of the write phase, and latency per kind of write). It prints, besides the lines above: `edit-to-diff incl. merged` (a write whose diff was merged into
a later frame counts at the time of that frame; **the verdict takes the stricter of the two lines**), the latency of the tabs **held by the object and by each shard** (the 101 carries `x-flarion-shard`), per
write the first tab, the median tab and the spread, the idle round trip to the object and through it to every shard, and the data center the object and each shard run in (`object runs in MXP; shards in ...`).
**Where the object lands decides much of a run**: hosts differ by up to 2.5x in CPU, and an object that lands in the data center the load generators run in (MRS from here) competes with them.
Compare runs of one day and read the data center line before the numbers.

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

**Third pass update (2026-11-08):** the single bundle is gone, see "Third pass" below (the table above is the second pass's; 60 ms of `Worker Startup Time` is now 2 ms and the `/healthz` upgrade 240 to 260 ms).

What was left after the second pass: the script carries the server rendering of the whole app (entasis, charts, every page: about 40% of it), the query layer and the editor.
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
| 2026-11-08 (second pass) | before: one object holds every socket | 1,000 | 20 | 500 / 8 | in-DC | 76 to 90 / 182 to 350 / 251 to 510 ms (three runs of 20 to 30 s) | commit call 98 to 109 / 192 to 359 ms | 0 of 400 to 600 | 0 | |
| 2026-11-08 (second pass) | 4 socket shards, 32 to 64 sockets kept, governed client cached, fan-outs merged under load | 1,000 | 20 | 500 / 8 | in-DC | best p50 66 to 75, p95 157 and 165 ms; typical 72 to 96 / 250 to 360 ms; 5 of 22 runs saturated (commit call p50 of seconds) | commit call 44 to 63 / 106 to 215 ms when not saturated | 0 of 600 to 1,200 when not saturated, up to 893 failed (`overloaded`) when saturated | 0, or 165,472 in the one saturated 60 s run | |
| 2026-11-08 (second pass) | same, three consecutive official runs of 60 s | 1,000 | 20 | 500 / 8 | in-DC | **80 / 263 / 575 ms** (object MXP); then 23.4 s / 35.1 s (saturated, object in CDG); then 7.6 s / 10.8 s (saturated, 893 of 1,200 writes refused) | commit call 55 / 144 ms; 17.0 s; 4.6 s | 0; 0; 893 | 0; 165,472; 0 | |
| 2026-11-08 (second pass) | A/B on one deployment, `--shards 4 --local 64` then `--shards 0`, twice | 1,000 | 20 | 500 / 8 | in-DC | shards 185 / 700 and 77 / 522 ms; direct 84 / 268 ms and a saturated run (13.4 s / 14.0 s) | | 0 | 0 | |
| 2026-11-08 (second pass) | bare delivery, `--echo 200`, 20 per second, no commit | 1,000 | 20 | 500 / 8 | in-DC | direct 34 / 98 ms (object MXP), 86 / 222 ms (object MRS); 4 shards 14 / 50 ms; 8 shards 24 / 82 ms | | | | |
| 2026-11-08 (second pass) | cold probes from the laptop, `run.ts --cold-probes 5 --cold-idle 20` | 10 | 2 | 50 / 5 | laptop | | | | | first window p50 593 to 674 ms, max 745 to 997 ms (open 530 to 600, hello to snapshot 65) |
| 2026-11-08 (third pass) | split script, thin object classes, per-commit memos, six official-style runs of 60 s (two builds, three runs each), see "Third pass" | 1,000 | 20 | 500 / 8 | in-DC | object MXP: **67 / 182 / 300 ms** and 77 / 333 / 811 ms; object CDG: 435 / 1,617 ms (degraded, commit call p50 225 ms); saturated (3 of 6, one with the object in MRS, two not recorded): 4.5 s / 11.3 s, 7.0 s / 10.1 s (684 of 1,200 writes refused), 26 s / 35 s | commit call 54 / 117 ms and 59 / 189 ms when not saturated | 0 of 1,200 except the one run that refused 684 | 0 except two saturated runs (225,548 and 250,009 not delivered by the end of the run) | |
| 2026-11-08 (third pass) | cold probes from the laptop, `run.ts --cold-probes 5 --cold-idle 25`, split script and thin classes | 10 | 2 | 50 / 5 | laptop | | | | | first window p50 545 ms, max 937 ms (open 483, hello to snapshot 62) against 593 to 674 before |

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

The third pass (below) moved the commit CPU, the script and the cold dial; its own "What is left" is the current list, the bullets here are the second pass's.

- **The 150 ms line at 1,000 tabs and 20 writes a second is not met.** Second pass (docs/spikes/p4-scale.md "Second pass"): the best runs reach a p95 of 157 to 183 ms (p50 66 to 75), a typical run 250 to 360
  ms, and a quarter to a third of the runs saturate the object's thread completely (a slow host: one `setProp` commit costs 19 to 25 ms of CPU against 9 to 11 ms on a fast one, then 20 commits a second with the
  fan-out of 17,000 frames are more than it can do). Socket shards (`SOCKET_SHARDS`, off by default, on in staging) halve the delivery of a bare fan-out at p95 but add a 15 to 19 ms hop and land in
  other data centers than the object; measured on real writes they are not better (A/B above). What would move the line: a commit and a view maintenance that cost a third of the CPU (the ORM and
  policy layers are 0.15 to 0.4 ms a call and a commit makes a few dozen; the maintenance of every touched unit goes through the query compiler each time: cache the compiled SQL per filter
  shape and registry generation), group commits (several queued writes in one transaction), and a smaller script so that no isolate pays 350 ms to start.
- **Slow consumers.** An acknowledged `seq` in the client's `ping` would let the object skip a tab that lags by hundreds of commits (it would be marked stale and resynchronized like a hidden
  tab of an overloaded object, `WorkspaceSocketApi.resync`) instead of queueing frames toward it.
- **The cold first window** is 164 to 264 ms when an isolate is warm and 450 to 997 ms when none is (593 to 674 ms at p50 in the second pass; the object's own wake is 35 to 66 ms of CPU and the
  snapshot 65 ms). A WebSocket upgrade that the Worker answers by itself takes 335 to 607 ms on staging against 140 to 190 for a plain request: the floor is the size of the script (above), so 300 ms is not
  reachable without separate modules for the app's rendering and for the object implementations.
- `roaring.wasm` is instantiated by every object wake (`ensureRoaring` in the constructor); making it lazy would save a few milliseconds of a cold wake and was not worth the risk of mixed modes.

Local smoke on the development server, for reference (2026-11-08, 10 tabs, 5 writes/s, 5 views, 50 rows): edit-to-diff
p50 11.5 ms, p95 24 ms; cold first window 17 ms.

## Third pass: commit CPU, output gate, script size

Targets of this pass (at 1,000 tabs, 20 writes a second, inside Cloudflare): edit-to-diff p95 150 ms, cold first window 300 ms, no saturated run. **Not met**; what moved, with the
evidence, and what is left is below. Tools added: `tests/workers/scale/sql-trace.test.ts` (the statements of one commit, by shape and caller; `VITE_TRACE_PRINT=1`, `VITE_TRACE_WHERE=1`), `scripts/profile/`
(a V8 CPU profile of the built Worker through `wrangler dev`'s inspector, see its header) and, in `scripts/postbuild.mjs`, `WORKER_MINIFY=off` (readable frames), `WORKER_META=<file>` (the esbuild metafile) and
`WORKER_SPLIT=off` (the old single bundle).

### 1. Commit CPU

A local profile at 1,000 tabs (`wrangler dev`, unminified build, object samples only) put the object at 10% of a thread at 20 writes a second: the send of the frames (`ws.send`, native) 32%, SQLite `exec`
14%, view maintenance and derivation the rest. The statements per commit were the measurable lever (the Worker's HTTP path, which dominates the same profile, runs in another isolate in production):
a `setProp` of a number on a workspace with 10 tabs x 8 views made **107 statements**, of which 80 were view maintenance: every touched unit asked the same questions again (are these candidate pages live,
are they in the collection, what is the collection's source, what is the page-number bound), the sort tuples of the neighbours were read again for each binary-search probe, and a write that no index holds
rewrote the search index.

| Per commit (10 tabs, 8 views, 500 rows) | statements before / after | local wall before / after |
| --- | --- | --- |
| `setProp` amount (3 sorted or filtered units touched) | 107 / 38 | 2.2 / 1.5 ms |
| `setProp` status (hot option property) | 93 / 37 | 1.8 / 1.3 ms |
| `setProp` notes (text no view reads) | 28 / 21 | 1.1 / 0.9 ms |

(Local wall time is a ms-granular clock averaged over 100 commits and noisy by 20%; the statement counts are exact and guarded by the trace test.) On staging, `wrangler tail` `cpuTime` of `apply` at 1,000 tabs on a slow host
(CDG): p50 15 ms, mean 16.6, p95 29 (the second pass measured 19 to 25 ms on slow hosts at 10 tabs). That is **about a third less, not two thirds**: the base of a commit (authorization, the op, the change rows, 21 statements) is
untouched and the sends are native cost.

What changed:
- **`MatchMemo`** (`engine/index.ts`): the candidate checks of one commit's maintenance share what is the same for every unit: liveness per page, collection membership per page, the collection's source, the page-number bound.
  `RowReader.nums` keeps ids for good (a dense number never changes), `RowReader.liveIds` is remembered for the length of one maintenance pass (`withLiveMemo`; nothing is written while it runs).
- **A sort-tuple store between commits** (`LiveHub.#tupleStore`, handed to `TupleCache`): the probes of the binary search over a unit's order read each neighbour's tuple once, not once per commit. The tuples of the pages a
  commit wrote (`valueProps`, `fields`, `edited`) are forgotten, all of them when a definition, the clock, a lifecycle or a move changed, or past 100,000 entries. The fuzz (`staleUnits` compares each unit with a fresh evaluation) passes with it.
- **Writes that are not read back**: the driver asks SQLite for `changes()` after every write; the EAV writes and the search index writes do not read the count, so their statements carry `/*quiet*/` (`db/quiet.ts`) and skip that read (7 statements
  a commit). The ORM-visible `$executeRaw` keeps its count (the driver's contract tests).
- **The search index is not rewritten for a number, checkbox or select** (`indexChanges`: only titles and text-like properties re-read the page), and **a page stamped by its own write is not stamped again** by the commit
  (`EavOpContext.stamped`).

Asked for and not done, with the reason:
- *In-memory candidate membership from a per-unit value cache*: with the memos above a value-only commit asks SQLite for 6 to 8 statements of membership and tuples; evaluating the filter AST in memory needs the page's current values (a `p_*` read
  per page and property: the same statement) and a second implementation of every operator that the oracle tests would have to cover again. The measured gain left is a few statements.
- *Compiled SQL and plans per filter shape*: workerd keeps prepared statements by text and the plan per filter (`compileFilter`) is two statements a commit now; the JavaScript that builds them did not show in the profile.
- *Grouping queued commits into one transaction*: nested transactions are savepoint frames in this driver (`do-sqlite-driver.ts`), so isolating a failing commit inside a group is possible, but what a group would share is the
  transaction's begin and end, not the statements, which are the cost; the fan-outs of queued value-only commits are already merged (`mergeCommits`) and each mutation keeps its own `seq`, `mid` and change rows. Not worth the risk to the `seq` semantics.
- *Allocation churn in the fan-out*: the profile shows 0.6% in the collector.

### 2. The output gate

Durable Objects hold every outgoing message until the writes made before it are durable: HTTP responses, RPC answers and calls, subrequests and `WebSocket.send` alike (the "output gate"). So the frames of a commit leave about 17 to 22
ms after its transaction (the measured `storage.sync()` of the second pass), and so do the `push` calls to the socket shards and the writer's own answer. Findings:
- There is **no per-message escape**. `allowUnconfirmed` exists on `storage.put/delete` (the key-value API), not on the SQL API the change log uses, and it would let a diff reach collaborators before the write it describes is durable: after a crash they
  would show a change the workspace does not have. The plan does not relax durability for the writer's ack and collaborators see what the writer's ack promises, so **nothing was changed**.
- What the platform does allow is overlap: the gate waits for the last write issued before the send, and the fan-out's CPU (maintenance, derivation) runs while the confirmation is in flight. The commit's transaction is issued first
  and the fan-out follows, so the CPU of the fan-out is already hidden behind the wait (the first-tab p50 of a write, 25 to 50 ms, is that wait plus a cross-data-center hop).
- The unit rows (`UPDATE sub_unit SET ids`) are plain writes issued during maintenance: they move the end of the wait by the length of the maintenance (3 to 8 ms of CPU on staging). Persisting them after the sends would hide that and was
  **not done**: after a crash between the two a stored unit would be older than the log, and incremental maintenance would then diff against it.

### 3. Script size and cold start

Measured model of the dial of a fresh isolate (`/healthz` with `Upgrade: websocket`, 12 requests, p50): about **66 ms + 75 ms per MB of module evaluated + 45 ms per MB uploaded but never imported**. A lazily imported chunk is not free: the
measurements say workerd takes in every uploaded module when it loads the script (parse or compile, we cannot see which), so a chunk nothing imports still costs about 60% of what an evaluated one does. Splitting alone therefore helps less than it looks (second row), and what a start-up needs is both a small evaluated
closure and a small upload.

| Deployed (staging) | uploaded | evaluated at start | `/healthz` upgrade p50 | `Worker Startup Time` |
| --- | ---: | ---: | ---: | ---: |
| second pass: one minified module | 5.75 MB | 5.75 MB | 338 to 349 ms | 60 to 100 ms |
| split into `wc-*.js` chunks (esbuild `splitting`, uploaded as ESModule rules) | 5.14 MB | 2.05 MB (the object classes' imports) | 319 to 333 ms | 34 ms |
| + thin object classes, SSR components of `ssr = false` routes stubbed, roaring's embedded wasm dropped | 4.03 MB (1.30 MiB gzip) | 8 KB | **243 to 262 ms** | 2 ms |

How: `scripts/postbuild.mjs` rebuilds the Worker from `src/worker.ts` with code splitting (the plugin's single-file bundle inlines every `import()`), `wrangler.jsonc` has `rules: [{ type: ESModule, globs: ['**/wc-*.js'] }]`
at the top level and in both environments (a rule written `wc-*.js` does not match the `./wc-...` specifier and wrangler then inlines the chunks again), `.assetsignore` has `wc-*.js`. `src/server/objects/lazy.ts` makes `WorkspaceDO`, `PageDO` and `SocketShardDO` thin classes
whose constructor loads the implementation inside `blockConcurrencyWhile` and whose methods forward (`WORKSPACE_METHODS`... are checked against the real classes by `tests/workers/objects/lazy.test.ts`; edytor's `attachRoom` installs `alarm` on the instance, which a first version missed and the
P3 gate's search test caught). Every route of the app is `ssr = false`: SvelteKit never calls the components it imports lazily for them, so their server build (1.4 MB: entasis, charts, `SloDashboard` 493 KB, `DataTable` 247 KB) is replaced by a stub that throws; the root layout and the error page keep theirs.

What the 4.03 MB is (minified bytes in the split output, 3,985 KB): viborm 1,177 KB (two copies of its client, 573 KB: `viborm/migrations` pulls a second one; the dialects the app never uses are in too), SvelteKit server runtime plus the root layout and error page 436 KB,
edytor 364 KB, the object, engine and live loop 293 KB (the generated migration estate 82 KB), the better-auth stack about 850 KB (better-auth 196, kysely 184, `@better-auth/core` 131, zod 105, simplewebauthn 62, asn1js 62, x509 50, jose 47), the rest under 30 KB each.
Before this pass the one bundle also held 1,512 KB of SvelteKit server output and 257 KB of roaring's embedded wasm (workerd compiles it from the `CompiledWasm` module; the base64 copy was dead).

**Cold first window, from the laptop** (`run.ts --cold-probes 5 --cold-idle 25`): p50 545 ms, max 937 ms (open 483 ms, hello to snapshot 62 ms), against 593 to 674 ms. **Not 300 ms.** A dial still evaluates 1.85 MB on the Worker side (the `auth` chunk: better-auth, the viborm D1 client, kysely)
and a cold object wake evaluates 1.93 MB (the `workspace-do` chunk and viborm), at about 75 ms a MB, before four client round trips. Getting under 300 ms means those two closures near 0.5 MB each: a session check that does not load better-auth when the cookie cache is valid (its `getSession`
also decides refreshes, versions and restricted sessions, so a copy of it is a security decision, not a build change), and the object's rarely used parts (files, export, import, backup, AI, embeddings) behind `import()`.

### 4. Earlier work that cost something

Nothing was removed. The socket shards were re-measured against the object holding every socket, same build, alternated (30 s runs): shards 4 / local 64 gave 71 / 271 ms (object CDG) and one saturated run (395 / 2,266 ms); direct gave 159 / 887 ms (CDG) and 129 / 730 ms (MXP) with a
commit call p50 of 155 to 175 ms, because the object's thread then also does the 1,000 sends. The shards stay (staging only). The merged fan-outs and the head coalescing are the cheap parts of the hot path.

### What the runs say

Six runs of 60 s (the official shape), two builds, spaced: the two objects that landed in MXP kept up (p50 67 and 77 ms, p95 182 and 333 ms, no failed write, nothing missing, commit call p95 117 and 189 ms); one in CDG ran slow (p50 435 ms, p95 1.6 s, not saturated)
and three saturated (one in MRS, two whose data center the report did not print: the commit queue grows to a p50 of 4 to 26 s, in one run 684 of 1,200 writes refused with "Durable Object is overloaded", which the store retries). Placement decides: hosts differ by 1.5x to 2.5x and the same code lands in a different data center on each run. The p95 line of 150 ms is **not met in any run** (best 182 ms), the 300 ms
cold window is not met (545 ms), and half of these six runs saturated (the second pass: a quarter to a third; the three runs of each build cannot tell the difference, and no run of this pass was captured by `tail` while saturated). What remains, with the evidence: on a slow host one commit is still 15 ms of object CPU (`tail`) plus the 1,000-tab fan-out, with the 20 ms
output gate and a 13 ms hop to the shards on top of every frame, and the probes' own isolates add a few ms to each sample (above). Next steps in order of expected gain: the base of a commit (21 statements and the ORM's per-call overhead: authorization and the change rows in raw SQL), the two start-up closures above,
and fewer cross-data-center hops (the shards of one workspace land in different data centers, second pass).
