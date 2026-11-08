# Observability, SLOs and alerts

docs/PLAN.md "Operating targets" and "Observability" are implemented in three layers. Platform alerts come from Cloudflare
Notifications (configured once, below); the app's own signals come from Analytics Engine and an alert cron; errors are
collected by a Tail Worker.

## What is measured (Analytics Engine, `src/server/metrics.ts`)

One dataset per environment (`flarion_metrics`, `flarion_metrics_staging`; the `METRICS` binding). Every data point has
`index1` = the metric name, `blob1..` = labels, `double1` = the value:

| Metric (`index1`) | Labels (blobs) | Values (doubles) | Written by |
| --- | --- | --- | --- |
| `rpc` | procedure (`page.create`), status class (`2xx`) | latency ms, HTTP status | `/rpc` route |
| `mutation` | outcome | commit-to-last-diff ms (edit to diff), change rows | Workspace DO commit |
| `fanout` | | sockets reached, fan-out ms, rows | Workspace DO commit |
| `subs` | workspace id | subscriptions, shared units, sockets | Workspace DO alarm (hourly) |
| `storage` | workspace id | SQLite bytes | Workspace DO alarm (hourly) |
| `queue_lag` | queue | ms from the edit to the page being searchable, batch size | queue consumer |
| `reconnect` | `fresh` or `resume` | 1 | workspace socket `hello` |
| `doc_size` | workspace id, page id | bytes / quota (0 to 1), bytes | Page DO save |
| `api` | token id, `METHOD route`, status class | latency ms, HTTP status | public API |
| `error` | where, message, path | 1, exceptions, error logs | Tail Worker, `reportError` |

Writing is best effort and never throws. Analytics Engine samples under load: sums use `_sample_interval`, percentiles
`quantileWeighted`. The `api` metric names the token id, never its secret.

## SLO dashboard

Settings, **Operations** (owner of the workspace; `ADMIN_EMAILS`, a comma-separated list of emails, narrows it further):
`/<workspace>/admin`. It shows the plan's operating-targets table (`/rpc` availability, edit-to-diff p95, reconnect
rate, indexing queue lag, DO storage, page size) with the current value, whether the alert condition holds, and a 24 hour
series per signal. The numbers come from `admin.slo` (`src/server/admin/slo.ts`), which asks the **Analytics Engine SQL API**.

The Worker needs, per environment:

| Name | Kind | Value |
| --- | --- | --- |
| `ANALYTICS_API_TOKEN` | Worker secret | A Cloudflare API token with **Account > Account Analytics > Read** (`wrangler secret put ANALYTICS_API_TOKEN [--env ...]`) |
| `CF_ACCOUNT_ID` | var (in `wrangler.jsonc`) | The account id |
| `METRICS_DATASET` | var (in `wrangler.jsonc`) | The dataset name of that environment |
| `ADMIN_EMAILS` | optional var or secret | Who may open the dashboard (default: every workspace owner) |

Without the token the page says what to set instead of showing numbers; nothing else is affected.

## Alert cron

`*/5 * * * *` (`ALERT_CRON`, in the three `triggers.crons` of `wrangler.jsonc`) runs `evaluateAlerts` (`src/server/admin/alerts.ts`):
it evaluates the "Alert when" column of the plan's table and emails `ALERT_EMAIL` (Worker secret or var; without it the
breach is only logged) through the same mail interface as invites. A signal that keeps breaching mails once an hour (KV key
`alert:<signal>`); a signal with no data raises nothing.

| Signal | Alert when | Window |
| --- | --- | --- |
| `/rpc` availability | 5xx rate above 1% (at least 20 requests) | 5 minutes |
| Edit to collaborator diff, p95 | above 300 ms | 10 minutes |
| Workspace socket reconnects | `resume` hellos in the last hour above 5 times the weekly hourly baseline (and at least 20) | 1 hour vs 7 days |
| Indexing queue lag | slowest page above 5 minutes | 10 minutes |
| Workspace DO storage | any workspace above 5 GB | latest hourly gauge |
| Page document size | any page above 80% of its quota | latest save |

Thresholds are `THRESHOLDS` in `src/server/admin/slo.ts`. The "page above 80%" signal is also what the app shows its
writers (the Page DO enforces the 16 MiB quota).

## Cron triggers (`src/server/scheduled.ts`)

| Cron | Runs |
| --- | --- |
| `0 3 * * *` | Outbox drain, membership and share reconcile, outbox prune, the purge Workflows (trash older than 30 days), the nightly backup Workflows and the pending-restore safety net |
| `0 4 * * SUN` | Upload sweep (uploads begun more than a day ago and never committed) and the **export sweep**: everything under `exports/` in the files bucket older than 7 days, finished zips and the scratch parts of failed runs (`src/server/export/sweep.ts`; 7 days is also the TTL of the job record in KV, so a link never outlives its record) |
| `*/5 * * * *` | The alert evaluation above |

Each job logs one `[cron] <name>:` line with its counts (Workers Logs).

## Tail Worker (errors)

`workers/tail/` is a second small Worker with its own `wrangler.jsonc`. The main Worker lists it in `tail_consumers`
(staging: `flarion-tail-staging`; production: `flarion-tail`; not in local dev). For every invocation that failed (an
uncaught exception, `exceededCpu`, `exceededMemory`, an `error` log) it writes an `error` data point to the same dataset
and one JSON log line. Deploy it **before** the main Worker (a `tail_consumers` entry must name a Worker that exists);
`scripts/deploy.sh` does it as the step before the main deploy (`--skip-tail` to leave it out), by hand:

```bash
npx wrangler deploy -c workers/tail/wrangler.jsonc --env staging
npx wrangler deploy -c workers/tail/wrangler.jsonc --env production
```

Workers Logs are on (`observability` in `wrangler.jsonc`), with invocation logs.

## Cloudflare Notifications to configure (dashboard, once per account)

Notifications > Add. Destination: the owner's email (or a webhook).

| Notification | Why |
| --- | --- |
| **Workers: Usage / Error rate** for `flarion` and `flarion-staging` (Workers, Observability, Alerts) | Whole-Worker 5xx and exceptions, independent of our own metrics, in case the app cannot report itself |
| **Durable Objects** (platform incident and billing/usage notifications) | A stuck object class |
| **D1: database approaching its storage limit** and **D1 incidents** | The directory is small; this is the early warning |
| **Queues: backlog** (consumer lag / dead letters) on `flarion-jobs` | Cross-checks the app's own queue lag signal |
| **R2: usage** (storage and operations) on `flarion-files` | Files and backups grow here |
| **Workers AI / AI Gateway: spend or error spike** | Ask AI and writing actions run on it; no usage caps in the app |
| **Cloudflare incident and maintenance notices** (Health, Incident Alerts) for Workers, D1, R2, Queues, Vectorize, Email Service | Know when it is not us |
| **Billing: usage-based** | Workers Paid plan overage |

Our own alert cron covers what Cloudflare cannot see: edit-to-diff latency, reconnect storms, indexing lag, one workspace
approaching 5 GB and one page approaching its document quota.

## Runbooks

The plan's runbooks (Workspace DO overloaded, D1 unavailable, Workers AI or Vectorize down, restore a workspace, bad DO
migration) live in docs/PLAN.md; the restore drill is `docs/ops/restore.md`, load tests `docs/ops/load-test.md`.
The AI features turn themselves off with a banner when Workers AI answers `AI_UNAVAILABLE`; nothing else depends on them.
