# Backups and restore runbook

Two independent safety nets protect a workspace's metadata (page tree, properties and values, views, grants, change log,
file records). Use whichever fits the failure.

| | Point-in-time recovery (PITR) | Logical export |
| --- | --- | --- |
| What | Cloudflare's continuous SQLite log of the Workspace DO, bookmarks per timestamp | `backups/ws/{workspaceId}/{YYYY-MM-DD}.jsonl.gz` in the files bucket, one per night |
| RPO | Seconds, any instant in the last **30 days** | Up to 24 h (the 03:00 UTC cron) |
| Use when | A bad write, a bad deploy, a mass delete: the object is alive and you know roughly when it went wrong | The object is destroyed, corrupted beyond a rollback, or the 30-day window has passed (backups are kept 30 days too, so this is for "PITR is unavailable") |
| Cost of using it | The object restarts; everything written after the chosen time is lost (an undo bookmark is returned) | Everything since the backup is lost; the load is a batched import (see below) |
| Where it runs | `POST /admin/restore {"mode":"pitr"}` | `POST /admin/restore {"mode":"export"}` |

Prefer PITR when it applies: it has no gap beyond the instant you pick. PITR does not work in `pnpm dev` or the vitest pool
(workerd's local storage has no bookmarks): it is only exercised for real on staging and production, and the drill below does it
there.

## What is and is not restored

| Data | Restored by | Notes |
| --- | --- | --- |
| Workspace DO tables: pages, properties and values (EAV), collections, views, teamspaces, members, grants, links, `file` records, `visit`, change log and `seq`, `mutation` keys | Both paths | A logical export carries `meta, member, teamspace, teamspace_member, page, property, p_text, p_num, p_date, p_ref, value_count, collection, collection_member, view, grant, link, file, file_meta, visit, dependency, mutation, change` |
| Search index (FTS5 `search`), `page_text`, `embed_chunk` | Rebuilt | Titles and properties by `reindexAll` right after an export import; **bodies by the indexing replay**: one `index-page` job per live page on the `JOBS` queue, the consumer reads each body from its Page DO. Lag shows on the indexing-queue SLO (target under 60 s) |
| Live registry (`socket_*`, `sub_*`), `open_room`, visibility sets, registries in memory | Dropped | Every connected tab is closed with `resync` (4503 try-again) and reconnects with its last `seq`: it replays or takes fresh snapshots |
| Page bodies (Page DOs) | Not touched | Each Page DO snapshots to R2 (`ws/{ws}/pages/...`, history 30 days) and survives the loss of the Workspace DO. A PITR of the Workspace DO does not roll bodies back |
| D1 (users, workspaces, memberships, tokens, flags) | `wrangler d1 time-travel restore flarion --env staging --timestamp <ISO>` (30 days) | After a D1 restore, the nightly `membership reconcile` re-pushes memberships into the Workspace DO; run it by hand with the outbox drain if you cannot wait |
| User files in R2 (`ws/{ws}/{fileId}`) | Not restored | R2 has no versioning here. The backup restores the `file` rows, not the bytes. A file deleted from R2 is gone |
| Vectorize chunks | Re-embedded by the replay | Stale vectors of pages that no longer exist stay until the page is purged |
| KV, Analytics Engine | Not restored | KV holds caches and flags (flags live in D1) |

A logical export is **consistent** when no write happened during it: the object holds its commit queue (writes wait, none is
dropped, up to 60 s) between `backupBegin` and `backupEnd`, and the backup is retried up to three times if the change log moved.
`LATEST.json` and the Workflow result carry `consistent`. A workspace too large to export in 60 s ends up `consistent: false`: do
not use such a file unless PITR cannot help, and say so in the incident notes.

## Setup (once per environment)

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put ADMIN_KEY --env staging      # then --env production, another value
```

Without `ADMIN_KEY` the `/admin/*` routes answer 404: nothing is exposed by a deploy that forgot it. A Worker secret rather than
a user role, on purpose: a restore is needed exactly when workspace data (including who is an owner) cannot be trusted, and
the route must not depend on a session, a cookie or the object it is repairing. The key is compared in constant time. Rotate it
by putting a new value; keep it in the team's password manager, never in a ticket.

```bash
export BASE=https://flarion-staging.beynar.workers.dev ADMIN_KEY=...      # production: https://flarion.beynar.dev
export WS=<workspace id>                                                  # the id in /w/<id> URLs, or: wrangler d1 execute flarion-staging --remote --command 'select id,name,slug from workspace'
```

## Runbook: restore a workspace

1. **Freeze the damage.** Tell the workspace's people to stop editing (the restore closes their sockets anyway). If a bad
   deploy caused it, roll that back first (`wrangler versions deploy <previous>@100 --env <env>`, what `scripts/deploy.sh` does on a failed rollout), otherwise it writes again.
2. **Look at what you have.**
   ```bash
   curl -s -H "x-admin-key: $ADMIN_KEY" "$BASE/admin/backups?workspaceId=$WS" | jq
   ```
   Returns the backups newest first with sizes, `latest` (the manifest: rows, bytes, `headSeq`, `consistent`) and the PITR window.
3. **Pick the path.**
   - PITR, to a time just before the damage (ISO string or epoch ms; at most 30 days back, not in the future):
     ```bash
     curl -s -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' "$BASE/admin/restore" \
       -d "{\"workspaceId\":\"$WS\",\"mode\":\"pitr\",\"timestamp\":\"2026-11-08T09:41:00Z\"}" | jq
     ```
     The object arms `onNextSessionRestoreBookmark(getBookmarkForTime(ts))` and aborts itself (the call that arms it fails by
     design; the Worker tells that from a real failure by a marker the object leaves in KV, `restore:pending:<id>`), then the
     Worker calls `afterRestore` on the restarted object, which replays indexing. The answer carries `undoBookmark`: write it
     down. Restoring that bookmark (`onNextSessionRestoreBookmark`) undoes the restore, valid for the same 30 days.
   - Logical export, into a destroyed or empty object:
     ```bash
     curl -s -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' "$BASE/admin/restore" \
       -d "{\"workspaceId\":\"$WS\",\"mode\":\"export\",\"date\":\"2026-11-08\"}" | jq
     ```
     Into an object that still holds data the call answers **409**: add `"force": true` to replace its rows with the backup.
     The file is read and verified completely first (gzip, checksum, per-table counts, trailer, workspace id); a bad file answers
     **422** and the object is not touched. Then rows load in batches of about 1 MiB, each in its own transaction (a retried
     batch changes nothing), `page.parent_id` is set last (a page can sit under a parent created after it), the loaded row counts
     are compared with the trailer, the change log's counter is restored (the next `seq` continues after the export's), titles and
     properties are re-indexed, and indexing is replayed. An export made by older code restores into newer code (columns are
     matched by name, new ones take their defaults); one made by newer code drops the columns this version lacks and says so in
     the answer.
4. **Check it** (below).
5. **If the replay did not run** (the request died after arming PITR): the nightly cron finishes pending restores
   (`finishPendingRestores`), or do it now:
   ```bash
   curl -s -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' "$BASE/admin/restore" -d "{\"workspaceId\":\"$WS\",\"mode\":\"replay\"}" | jq
   ```
6. **Tell the workspace** what time they are back at, and that anything after it must be redone. D1-side changes (memberships,
   tokens) are separate: check `Settings > Members` after a restore to a time before someone joined.

## Verification checklist

- [ ] `GET /healthz` is ok and `wrangler tail --env staging` shows no `[workspace]` errors for the workspace.
- [ ] Open the workspace: sidebar tree, one database view (row count against the pre-incident number), one shared page.
- [ ] `seq` moved forward, not back: make an edit and watch a second tab receive it (the live loop resumed; tabs reconnected on their own).
- [ ] Search for a title (back from the title index immediately) and for a phrase from a page body (back as the indexing queue drains; the queue's lag SLO is under 60 s).
- [ ] A member and a guest see only what they should (the grant table is part of the restore; open a guest-shared page as the guest).
- [ ] For a restore from export: the answer's `counts` match `latest.tables` of the manifest, and `consistent` was true.
- [ ] Note in the incident log: time restored to, path, `undoBookmark`, backup key.

## Scheduling and retention

The daily cron (`0 3 * * *`, `NIGHTLY_CRON`) starts one `BackupWorkflow` instance per live workspace
(`backup-<workspaceId>-<YYYY-MM-DD>`, id-deduplicated, so a double cron run is harmless): a retried step pages the object and
streams a multipart upload into `backups/ws/{id}/{day}.jsonl.gz`, a second step deletes backups older than **30 days** (the
newest copy is always kept, even if older) and `LATEST.json` is rewritten. Backups of workspaces that are deleted or gone are pruned
by the same rule. Without the Workflow binding (local dev) the cron runs the same function inline. Outcomes go to the log
(`[backup] <id>: N rows, B bytes, seq S`) and to Analytics Engine (`blobs: backup, ok|failed, <id>, consistent|inconsistent`;
`doubles: bytes, rows`): alert on any `failed`, and on a workspace with no `ok` in 26 hours. `backups/` is a separate prefix of
the files bucket that no route serves, the upload sweep never lists, and workspace deletion (`ws/{id}/`) never touches.

## The drill

Run it after every change to the backup code, and quarterly on staging.

1. Automated (workerd, real SQLite, the test R2): `pnpm exec vitest run --project workers tests/workers/backup`. The drill test
   (`drill.test.ts`) builds a workspace (database with 24 rows and a saved view, a re-parented page, a grant, a member), backs it
   up with the nightly function, **destroys** the object, restores from the export, and asserts: all 22 authoritative tables equal
   row by row, the same `queryView` answer, the same member and grant, search by title back, `seq` after the restore above the old
   head, and one index job per live page on the queue. A second test corrupts rows behind the object's back and restores with
   `force`. Others cover truncated, edited, foreign and renamed files (refused before the object is touched), retention, the
   fence, and the admin route (404 without the secret, 401 for a wrong key).
2. Manual on staging (this is the only place PITR runs for real): create a throwaway workspace with a few pages; note the time;
   delete a page; `mode:"pitr"` to the noted time; confirm the page is back and indexing replayed; then `GET /admin/backups`,
   `mode:"export"` with `force` from last night's file; run the checklist; delete the workspace.

What the drill cannot show locally: PITR itself (`getBookmarkForTime`, `onNextSessionRestoreBookmark` and the abort have no local
implementation; the order of the calls, the window checks and the marker are tested against a fake storage), multipart upload sizes
beyond a few MiB, and restore time for a multi-GB workspace (not measured: the export is paged in 1 MiB RPC replies and the import
batches in transactions, so memory stays flat; time is linear in rows).
