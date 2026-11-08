# Migrations and the bad-migration runbook

Plan rule (docs/PLAN.md "Runbooks"): *Durable Object migrations are additive and behind a flag; roll back by deploying the
previous version, which still reads the new columns.* This page says what that means in this repository, how to ship a migration
safely, and what to do when one goes wrong.

## The four kinds of schema change

| Kind | Where | Applied | Flag-gated? |
| --- | --- | --- | --- |
| **Durable Object classes** (`migrations` in `wrangler.jsonc`: `new_sqlite_classes`, renames, deletes) | `wrangler.jsonc`, tag `v1` today | By `wrangler deploy` (a *full* deploy, not a gradual `versions deploy`: `scripts/deploy.sh` and the CI input `full_deploy` exist for this) | No. Changing the class list is rare, irreversible for a deleted class, and never needed for a new table. Do not rename or delete `WorkspaceDO` / `PageDO` |
| **Workspace DO, viborm estate** (`src/server/objects/workspace/migrations/estate.generated.ts`, from `workspace.schema.ts`) | Regenerate with `pnpm gen:workspace-estate` after a schema change (`tests/unit/db/workspace-estate.test.ts` fails while it is stale). After the first deploy only ever *append* (`ESTATE_FRESH=1` is for before the first deploy) | On each object's wake, in `blockConcurrencyWhile`, by `migrateOnWake` (`db/driver/migrate.ts`): one transaction, fail closed (a failure resets the object and fails its requests instead of serving a schema the code does not match) | No: the bundle applies as a unit. Its guard is the additive rule and the rollout (below) |
| **Workspace DO, raw steps** (`migrations/raw-steps.ts`: the live registry, FTS5, `page_text`, anything viborm cannot express; `ensureFilesTable`, `ensureSearchTables`, `ensureEavLayout` are idempotent `IF NOT EXISTS` bootstraps from the constructor) | Append to `RAW_STEPS` | On wake, synchronously, before the estate; each pending step in its own transaction, version in `raw_schema` | **Yes**: `{ flag: 'migration.<name>', statements: [...] }` (below) |
| **D1** (`migrations/d1`, global directory) | `pnpm db:generate` | `wrangler d1 migrations apply` in `scripts/deploy.sh`, before the deploy | By the same additive rule; D1 has Time Travel |
| **Page DO** (`page_meta`, edytor's own tables) | `CREATE TABLE IF NOT EXISTS` in the object | On wake | By the additive rule |

## Additive means

Allowed: new tables, new nullable columns or columns with a default, new indexes, new `meta` keys, new `RAW_STEPS` entries.
Never in one release: dropping or renaming a table or column, changing a type or a default the old code relies on, adding
`NOT NULL` without a default, tightening a constraint, rewriting data in place that old code reads differently. When a real
removal is needed use three releases (stop reading it; stop writing it; drop it, weeks later after the 30-day backups no longer
need it to restore into the previous code).

Why it matters here, specifically: a gradual rollout runs two versions at once (`ROLLOUT_STEPS: 10 50` in CI), and each Workspace
DO wakes on whichever version its request reaches. The newer version migrates the object; the older version, still serving
other objects and possibly this one after a rollback, must keep working against the migrated schema. An additive schema
guarantees that. Backups carry the same guarantee: a logical export made by older code restores into newer code (columns are
matched by name, new ones take their defaults), and PITR to before a migration just makes the object re-apply it on its next wake.

## Shipping a migration (the safe path)

1. **Write it additively**, with a test: `tests/unit/db/workspace-estate.test.ts` (estate), `tests/workers/backup/raw-steps-flag.test.ts`
   shows how to test a raw step and its gate. Run `pnpm exec vitest run` and `pnpm check`.
2. **Decide the gate.** A raw step that adds columns or tables the new code *needs* ships in two releases:
   - Release 1: the step, flag-gated and dark. In `raw-steps.ts` append `{ flag: 'migration.add-foo', statements: ['ALTER TABLE ...'] }`.
     Nothing applies while the flag is off; the code must not use the new columns yet.
   - Switch the flag on (below), watch, then release 2 ships the code that reads and writes the columns (guard it with the
     same flag until every object has migrated, or with a `PRAGMA table_info` check).
   An estate migration cannot be gated: keep it small, additive, and soak it (step 3).
3. **Soak on staging.** CI deploys `main` to staging first (`scripts/deploy.sh staging`: D1 migrations, then `wrangler deploy`). Open a
   few workspaces (the load-test workspace is a good one: `docs/ops/load-test.md`), check `wrangler tail --env staging` for
   `migrateOnWake` errors, and restore the latest backup into a fresh staging workspace (`restore.md`) to prove the old file loads
   into the new schema.
4. **Take a backup you can use.** Run the nightly job's function for the workspaces that matter just before the production
   deploy (`startBackupWorkflows`, or wait for the 03:00 UTC run and deploy after it), and note the time: that is your PITR target
   if you need one.
5. **Production deploys gradually** (10% -> 50% -> 100% with `/healthz` checks and automatic rollback in `scripts/deploy.sh`). The
   estate migrates each object as it wakes; watch the error rate and `[workspace]` log lines at each step.
6. **Turn the flag on gradually**: a row in the D1 `feature_flag` table, read through KV with a 60 s cache (`src/server/flags.ts`),
   `rollout` is a percentage bucketed by workspace id, so the same workspaces stay in:
   ```bash
   wrangler d1 execute flarion --remote --env production --command \
     "INSERT INTO feature_flag (name, enabled, rollout) VALUES ('migration.add-foo', 1, 5) ON CONFLICT(name) DO UPDATE SET enabled = 1, rollout = 5"
   ```
   Then 25, 100. An object applies the step on its next wake after the flag is on for it (the flag is read in the constructor only
   when the object has a gated step pending, so ordinary wakes cost nothing); to force a wake run the nightly job, or call any RPC.
   A flag lookup that fails reads as **off**: a flaky flag store delays a migration, it never runs one.
   Steps apply in order and a gated step that is off holds back the steps after it, so the flag can delay the schema but never reorder it.

## Runbook: a migration went wrong

Symptoms: a spike of `/rpc` and socket errors after a deploy, `[workspace]` logs from `migrateOnWake`, objects that fail to wake
(the platform resets an object whose migration throws, and its requests fail rather than run on a half-matching schema), or wrong data
after the new code started writing.

1. **Stop the rollout.** In a gradual deploy: `wrangler versions deploy <previous-version>@100 --env production --yes` (what
   `scripts/deploy.sh` does by itself when `/healthz` fails; find the previous version with `wrangler deployments status --env production`).
   The previous version still reads the new columns, so objects already migrated keep working.
2. **Switch the flag off** for a gated raw step (`UPDATE feature_flag SET enabled = 0 WHERE name = 'migration.add-foo'`, wait up to 60 s for the KV
   cache, or delete the key `flag:migration.add-foo` in the `CACHE` namespace). Objects that have not migrated yet stay as they are; the
   ones that have keep the (harmless, additive) column.
3. **Classify what is broken.**
   - *Objects fail to wake with a migration error, before any data changed*: the transaction rolled back, the object is at the previous
     schema. Fix forward (a corrected, additive step) or revert the commit, then redeploy. Nothing to restore.
   - *A raw step was half applied*: not possible within a step (each runs in one transaction with its version row), so an object is
     at step N or N+1, never between. A statement that errors halts the object at N and logs it on every wake until fixed. A step
     you wrote with `IF NOT EXISTS`-less DDL against a table that was already created by an earlier code path fails at once: make
     the corrected step idempotent (`IF NOT EXISTS`, `PRAGMA table_info` checks via `ensure*` helpers) and append it; never edit a shipped step.
   - *The estate bundle is wrong*: viborm records the applied state in the object; do not hand-edit it. Append a corrective estate migration
     (`pnpm gen:workspace-estate`) and redeploy. The previous version keeps working meanwhile because the change was additive.
   - *Data was written wrongly by the new code* (the real damage): restore the affected workspaces, `restore.md`: PITR to just
     before the first bad write (the bookmark survives a migration; the object re-applies the pending migrations on its next wake),
     or the last good logical export. Roll the code back first or it writes again. D1 side: `wrangler d1 time-travel restore`.
4. **Verify** with the checklist in `restore.md`, and write the incident down: the flag, the steps, the PITR target, the backup key.
5. **Never**: drop the new column "to clean up" before every version that might read it is gone and the 30-day backups are older
   than the change; run a destructive statement on production from `wrangler d1 execute` or an RPC without a backup you have tested
   loading; edit an already shipped `RAW_STEPS` entry or estate migration (objects have recorded it as applied).

## Pre-deploy checklist for a migration

- [ ] Additive only (no drop, rename, retype, `NOT NULL` without default).
- [ ] Raw step, if it is risky or large: behind `migration.<name>`, dark in release 1.
- [ ] `pnpm gen:workspace-estate` run if the schema changed; `pnpm exec vitest run` and `pnpm check` green; the workers tests apply the
      whole estate to a fresh object, so a broken migration fails there.
- [ ] A logical export from the previous version restores into the new schema (restore into a fresh staging workspace).
- [ ] A fresh backup taken right before production, and its time noted.
- [ ] Staging soaked: objects woke, no `migrateOnWake` errors in `wrangler tail`.
- [ ] The previous version id written down (`wrangler deployments status --env production`) for the rollback.
- [ ] `APP_VERSION` and `MIN_APP_VERSION` unchanged unless the socket protocol broke (docs: CLAUDE.md "Build version").
