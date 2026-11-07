# P3 spike: live views, trash and purge (Sync core)

What was built and measured for the P3 gate ("the live-update fuzz passes, restore is lossless, and diffs reach
collaborators within target"). Code: `src/server/objects/workspace/{live,view-unit,purge}.ts`,
`src/server/workflows/purge.ts`; tests: `tests/workers/{live,workspace,trash}`.

## Live loop

- A `view` subscription maps to a **view unit**: the ordered ids of every page the query matches (per group when
  grouped), whatever the actors can see. Each socket's window is the unit ANDed with its visibility set when the
  frame is built, so identical queries share one evaluation (`unitsOf`: canonical filter, `is me` queries per user).
- The unit is kept current incrementally (`view-unit.ts`): `sub_prop` (the property-to-subscription index) finds the
  units a commit's writes can touch; for the commit's candidate pages the engine's `matchesFilterMany`,
  `groupKeysOf` and `sortKeyOf` decide membership, group and position (binary search over the stored order).
  Tombstoned pages are removed without a query. A definition change, more than 40 live candidates, a hand-picked
  collection or a clock tick (relative dates) evaluate the unit again with `runQuery`.
- Per socket the diff is derived from the old and new window (remove, then add/move in order = the refill, then
  update, then count); a commit sends one frame per socket. Evaluating a view is asynchronous, so socket messages
  run in the commits' serial queue.
- Engine additions (additive): `QueryOptions.visible` may be `null`, `matchesFilterMany`, `groupKeysOf`,
  `orderGroups` (shared by `runGroups`).

## Fuzz

`tests/workers/live/fuzz.test.ts`: per seed a real Workspace DO with four actors (owner, two members, a guest; a
private teamspace; grants), a database with a collection (source AST or hand-picked), saved views, ~36 pages and
5 sockets x 6 random views (filters, sorts, groupings, windows, local filters, `props`). 70 steps of random
writes (values, options, moves, create, trash, restore, icons, grants, property options, view definitions, bulk
batches, batches that fail), window growth (whole view or one group), socket drops with a reconnect from `seq`,
and `evictDurableObject`. After every step each window every client holds, rebuilt from the frames, must equal
`queryView` (the engine's `runQuery` ANDed with the actor's visibility) for ids, order, totals, groups, titles,
cells and `$access`; the stored units must also equal a fresh evaluation at the end.
Default 16 seeds; `VITE_FUZZ_SEEDS=60 VITE_FUZZ_FROM=100` for a sweep, `VITE_FUZZ_SEED=n` replays one,
`VITE_FUZZ_STATS=1` reports counters. A mutation (the index ignoring written properties) fails within 11 steps.

Bugs the fuzz found while building: a row entering a group window while the same page sat in another group (no row
sent), group order after option edits (no `groups` op for untouched units), `last_edited` sorts after grants
(commit stamps every page with a record), shape changes (flat to grouped) needing a fresh snapshot.

## Latency (edit to collaborator diff)

`tests/workers/live/latency.test.ts`: 200-row database, 5 sockets, 5 shared views (sorted, grouped, filtered),
writes of sort values, groups, checkboxes, text and creates; time from the `apply` call to the diff arriving on
each other socket. 1000 writes, 4000 samples, workerd on a laptop:

| p50 | p95 | p99 | max | commit alone p50 / p95 |
| --- | --- | --- | --- | --- |
| 3 ms | 6 ms | 7 ms | 17 ms | 3 ms / 6 ms |

It includes the DO call but no network (target: 150 ms p95 in the same region). Timer resolution is 1 ms.

## Trash and purge

- `trash`: `can('full')` on the root, one transaction stamps the live subtree with one `deleted_at`, `trash_root`
  = the root id on those rows, one `trash` change row; descendants trashed earlier keep their own entry. The loop
  drops the pages from views, tree and backlinks; open rooms get `closeAll(4403, 'moved to Trash')`.
  Relation cells follow the Databases rules (dead targets drop out, none left reads `null`) and the loop sends the
  `update` ops on trash and restore (also the reverse side of two-way relations).
- `restore` (root only): clears the marker on the rows of that entry; a parent still in Trash means the teamspace
  root. Undo is the restore. Archiving a teamspace stamps its pages with one timestamp and no trash entry: it is restored from Settings > Teamspaces (`workspace.teamspaces.archived` / `.restore`, owners), not from Trash.
- Purge path (`purgePlan` -> `purgePages` -> `removeIndexRows` -> `PageDO.purge` -> `filesPurgePages` ->
  `deletePageVectors`): rows of EAV, relation cells of other pages, links, indexed text, grants, collections,
  views and members go; the change log keeps its rows (sequence numbers never move) without their values.
  `purgePages` answers the pages that are gone, so a retried step is safe. A tombstone with a child that is not
  yet old stays, and so do its ancestors. `page.purge` runs the same stages (rows now, rest through a `pages` run
  of the Workflow, inline without the binding).
- Daily cron (`0 3 * * *`) -> `startPurgeWorkflows`: asks every live workspace's DO whether it has trash older than
  30 days (one `purgePlan(cutoff, 1)` each: this wakes each object once a day, acceptable until P4 profiling),
  starts `purge-<ws>-<day>`; workspaces deleted over 30 days ago get `delete-<ws>` (vectors, every Page DO, the R2
  prefix `ws/<id>/`, `WorkspaceDO.destroy()`, the D1 rows).
