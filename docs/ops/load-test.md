# Load test

Scripted sockets and writes against staging (docs/PLAN.md "Testing, observability and operations: Load"). It
validates the three targets of "Performance, limits and scaling":

| Target (plan) | Measured as | Pass line |
| --- | --- | --- |
| A property edit reaches collaborators within 150 ms at p95, same region | `edit-to-diff (diff frames)` p95 | `--p95-ms`, default 150 |
| A view's first window renders within 300 ms from a cold object | `cold dial to first window` max | `--cold-ms`, default 300 |
| One workspace serves 1,000 concurrent tabs | `tabs: connected` with `--tabs 1000`, and the two lines above while they are connected | no tab fails to connect |
| Workspace socket reconnects below 1% of sockets per hour (operating targets) | `reconnects` percent per hour | 1 |

Code: `scripts/load/run.ts` (the CLI) and `scripts/load/lib.ts`; the test auth is
`src/server/auth/load-test-auth.ts` (guard: `load-test-guard.ts`).

## How it works

1. **Test auth.** There is no passkey UI in a script, so the Worker has a staging-only endpoint family,
   `POST /api/load-test/{users,workspace,cleanup}`. It answers a plain 404 (like a path that does not exist) unless
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
   with its `lastSeq`, as the app does.
4. **Writes.** For `--duration` seconds, `--writes-per-sec` random edits (35% `amount`, 35% `prio`, 15% `done`, 10%
   text, 5% creates) go through `/rpc/mutate` on an open loop (a write is sent on schedule even if the previous one
   is slow, so queueing shows up as latency). Each write's `seq` comes back in the response.
5. **Latency.** For every (write, tab) pair: the arrival time of the `diff` or `head` frame whose `seq` equals the
   write's, minus the time the write was sent. Arrivals within 1.5 s of a (re)connection are ignored (replays).
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
does). `write round trip (HTTP)` shows how large that floor is. Node's single thread also parses frames, so for
1,000 tabs prefer a cloud shell or a VM near the colo over a laptop on Wi-Fi; if the client itself saturates, the
`edit-to-diff` numbers include its queue. Run two processes with different `--run-id` and `--tabs 500` to spread it.

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
edit-to-diff (diff frames)     ...   THE TARGET: frames that carry a change a socket's views show
edit-to-head (no change here)  ...   frames for sockets whose views the write did not touch
edit-to-any-frame              ...
reconnects  ... % of sockets per hour
cold dial to first window      ...   the 300 ms target
errors      none
```

- **edit-to-diff** is the plan's "edit to collaborator diff". `n` counts (write, tab) pairs. `deliveries missing` is
  the number of (write, tab) pairs that received no frame at all (a head or diff is sent to every stream for every
  commit): anything above 0 is a bug or a dropped socket.
- **edit-to-head** is not a target: a socket whose views a write does not touch only needs the `head` to advance its
  `seq`. Against `pnpm dev` heads arrive in steps of about 200 ms (TCP delayed ACKs on the local proxy); that is a
  local artifact, not seen on the edge.
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
- **Window sharing.** The 1,000 tabs of `--users 25` are 25 people: the server derives one diff per person and view shape per commit
  and sends it on every tab of that person. A run with `--users 400` is the case without sharing (about 16x the derivations); use
  it as the stress variant.

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

## Results

Fill in after each staging run (commit the JSON next to this file if useful):

| Date | App version | Tabs | Writes/s | Views | Rows | edit-to-diff p50 / p95 / p99 | Cold first window max | Reconnects %/h | Errors | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |

Local smoke on the development server, for reference (2026-11-08, 10 tabs, 5 writes/s, 5 views, 50 rows): edit-to-diff
p50 11.5 ms, p95 24 ms; cold first window 17 ms. At 200 tabs, 8 views, 10 writes/s the same machine saturated
(write round trip p50 7.7 s: about 5 commits per second of throughput), which is the effect to look for at 1,000
tabs on staging.
