# viborm: limitations found while building Flarion, and the fixes we need

## Review outcome (2026-11-08)

The viborm maintainers reviewed this audit twice (two adversarial passes, real workerd, our own driver, schema and policy; evidence in
`/Users/arnaud/code/viborm-evidence/flarion-2026-11/`, verdicts in `reviews.md`). The sections below are left as we wrote them. Read them with
this section first.

### What was wrong in our audit

- **#2 (governed `update`/`delete` do nothing, silently) was a misunderstanding.** We had the claim only in comments. Under `$as`, a hidden, missing or
  readable-but-not-updatable row throws `NotFoundError` (V6001), nested writes throw `NestedWriteError` (V7001), `upsert` throws `ForbiddenError`; only
  `updateMany` / `deleteMany` answer `{ count: 0 }`. Verified on our driver (`tests/workers/db/governed-writes.test.ts`).
- **#5 (`$as` is expensive to build) was a misunderstanding.** Models are wrapped lazily, the policy is compiled once per schema and the actor goes in as
  parameters: `$as()` costs about 9.6 µs with our policy. Our "half of `apply`'s CPU" came from a local profile through the inspector. The cache we added is harmless,
  but the production gain was the registry hand-off (`docs/spikes/p4-scale.md`, corrected).
- **#4's cause was right, its consequence was not.** The four copies of a rule are the rule R1 (a body written `level = 'read'`, `level = 'comment'`...);
  we already write `level: { in: [...] }` bodies, so the compiler repeats nothing for us now. The depth failures that made us design around the limit
  came from **our adapter options** (`new SQLiteAdapter({ temporaryObjects: false })`, viborm's deep SQL form), not from the policy: with
  `deepExpressions: false` the plan's own sketch moves a page on workerd and `can` x4 fits (97 of 100 values, no headroom). The `level >= ?` fix we asked for is
  infeasible; we do not need it.
- **#1 is true and intended** (R4: a governed write's foreign key must target a row the actor can read, so that a missing and a hidden row give the same
  answer, no existence oracle) and our `reference: 'unchecked'` ask would have reopened that oracle. It also exposed a **hole in our own `create` rule**:
  `{ parent: 'update' }` said nothing about `teamspaceId`, so the policy accepted a guest's page under a shared parent with `teamspaceId: null` (or a
  member's with another teamspace). Only our raw INSERT enforced the equality.
- **#8: the maintainers called two of our five workarounds unnecessary; one was.** `annotateSqliteError` is dropped (viborm maps the same errors, codes and columns from the message).
  The maintainers said the same of the `ctx.storage.sync()` before `PRAGMA foreign_keys = OFF`; that one is **not** covered: viborm's base class only
  *declares* the `beforeForeignKeysOff` hook and does nothing in it (its doc says a Durable Object driver calls `sync()` there), so our override is the
  implementation, kept and now tested on its own.
- **#3 is fully true on Durable Objects** (the "refound once without `tables`" advice only works on D1: the DO cannot run without `tables`, which keeps
  FTS5 and `_cf_*` out of the managed set). `docs/ops/migrations.md` said "only ever append" for tables, which contradicted this entry; corrected.
- Our driver declares viborm's migration capability with `reservedTablePrefixes: "none"` and `BEGIN IMMEDIATE` exclusion, which a Durable Object cannot
  provide. Documented in the driver's header ("Known"); viborm 1.12.1 admits no other values.

### What Flarion changed

- `do-sqlite-driver.ts`: `deepExpressions: false` (not `sharedRelationBodies`: +30 to 45% CPU on `can`, transactions and `$access`, against about +5 to 10% for
  `deepExpressions: false`); `annotateSqliteError` removed; header note on the migration capability. `policy-limits.test.ts` now shows the sketch moving on
  workerd and keeps the default form as the failing reference.
- `policy.ts`: the page `create` rule states the equality with the parent's teamspace (`$row` / `up: 1`); `policy-create.test.ts` drives the governed create
  (a move now takes 66 bound values, was 56). Raw create and move stay raw.
- Governed single-row `update` / `delete` in `page-ops.ts`, `teamspaces.ts`, `grants.ts` no longer ask `can` first (`governed.ts`: one `can('read')` after a refusal
  keeps 404 vs 403 and the messages); `restorePage` checks the `updateMany` count; the edit stamp's `updateMany` is left unchecked on purpose.
- Docs: `docs/spikes/p0-policy-limits.md` (dated section with the numbers), `docs/spikes/p4-scale.md`, `docs/ops/migrations.md`.

### What viborm will ship

The `viborm/durable-object` driver (first party, `deepExpressions: false` by default, a depth test on workerd, widened migration-capability values and a real
migration lock hook); per-table **adoption** of existing tables (so a managed set can grow and our seven raw tables can come under it; 3 to 5 days);
the **R4 relaxation** (a reference is satisfied when the create rule equates it through `$row` to a key of a row it already proves readable: the oracle stays
closed and guests can create governed pages, which lets us drop the raw INSERT later); `.withoutRowid()`; governed `$rows` (a read-only governed raw surface);
the `TransactionClient` / `TransactionClientOf<Client>` type exports; a schema-validation refusal of a nullable field in a compound primary key; and the
`permissions.mdx` fixes (teach `level: { in }`, drop "walks once"). Page `move` stays outside viborm (it rewrites a subtree), by their decision too.

---

*viborm 1.12.1 on Cloudflare (Durable Object SQLite and D1), 2026-11-08. The evidence is in this repository:
`src/server/db/do-sqlite-driver.ts`, `docs/spikes/p0-policy-limits.md` (P0 and P2 sections),
`docs/ops/migrations.md` and `docs/ops/load-test.md`.*

The plan says viborm, with its permissions and soft-delete extensions, is **the only path to data**. In practice,
Flarion has about 290 viborm model calls, and about 480 hand-written SQL strings that run through viborm's raw
surface (`$queryRawUnsafe` / `$executeRawUnsafe`). Some of that raw SQL is legitimate: the query engine and
FTS5, which the plan allows. The rest exists because of the limits below. Each one makes us choose between
**bypassing the policy** (raw SQL with permissions checked by hand), **bending the data model** to fit the
compiler, or **maintaining platform glue** that belongs in viborm.

They are ordered by impact. Each entry gives what happens, why it hurts, the workaround in Flarion, and the fix
we want.

---

## 1. Governed writes that reference a row the actor cannot read are refused

**What happens.** Under `db.$as(actor)`, a `create` or `update` whose foreign key points at a row the actor
cannot **read** is refused. Example: `page.create({ teamspaceId })` by a guest, or by a member who was shared
one page of a private teamspace. That person may legitimately create a subpage there (they hold `update` on the
parent page), but they cannot read the teamspace row.

**Why it hurts.** Permission to write a row is decided by the rules of the row being written (`create:
{ parent: 'update' }`). Readability of every row it references is an extra condition the policy never stated.
The policy author can't express "this reference is fine because the placement rule already allows it".

**Workaround.** Page `create` and `move` are raw `INSERT`/`UPDATE` statements, issued after explicit checks
that restate the policy (`src/server/objects/workspace/authorize.ts`, `createPage`, `movePage`). The permission
matrix tests cover them. That gives two sources of truth for the most security-sensitive writes in the app.

**Fix wanted.** Check the referential condition against the **policy of the written model**, not against read
access to the referenced row. At minimum, offer an opt-out per relation in the policy, for example
`fields: { teamspaceId: { reference: 'unchecked' } }`, or a rule such as
`references: { teamspace: 'placement' }`.

## 2. A governed `update` or `delete` that matches no permitted row does nothing, silently

**What happens.** `db.$as(actor).page.update({ where: { id }, data })` on a row the actor may not change returns
without error and changes nothing. Only `create` throws.

**Why it hurts.** A permission bug or a stale client looks like success, and the caller sends `{ seq }` back to
a client whose edit never happened. It's also inconsistent with `create`, and with `assert`.

**Workaround.** Every write that matters asks `can` or `assert` first (`authorize.ts`, `teamspaces.ts`), which
costs an extra statement per write.

**Fix wanted.** Make a single-row governed write that matches nothing throw `ForbiddenError` or `NotFoundError`.
This could be opt-in (`{ strict: true }` on the client), defaulting to strict for `update`/`delete` with a
unique `where`. Many-row variants can keep returning a count.

## 3. Adding a table to an existing migration estate requires refounding it

**What happens.** A deployed viborm estate fixes its set of managed tables. Adding a model after the first deploy
can't be expressed as an additive estate step. The only way out is `ESTATE_FRESH=1`, which refounds the estate
and breaks every Durable Object that already recorded the old one.

**Why it hurts.** Every Workspace DO carries its estate, so an app that adds features adds tables. On D1, P2 had
to refound the estate in `migrations/d1-estate/` and **hand-write** `0002_p2_sharing.sql` from viborm's DDL.

**Workaround.** Seven tables are created with `CREATE TABLE IF NOT EXISTS` outside viborm, in idempotent bootstraps
(`ensureFilesTable`, `ensureSearchTables`, `ensureEavLayout`, and the `dependency`, `ai_state`, idempotency and
subscription-registry tables), plus a `RAW_STEPS` list of versioned raw migrations
(`src/server/objects/workspace/migrations/raw-steps.ts`). These tables have no viborm model, so no policy, no
types and no relations; every access to them is raw SQL.

**Fix wanted.** An additive estate migration that **widens the managed-table set**: new models become
`CREATE TABLE` steps appended to the history, with drift checks that accept new tables. This matters most for
per-tenant estates (`viborm/migrations/tenant`, Durable Objects), where you can't refound thousands of
databases.

## 4. The policy compiler repeats each rule once per level

**What happens.** With `levels: ['read', 'comment', 'update', 'full']`, the predicate for `read` is the **OR of
the rule body of every level at or above `read`**, so the body appears four times. With the plan's policy
(grants OR-ed over four subject kinds, a teamspace membership `EXISTS`, and the recursive ancestor walk), a
`parentId` move fails in SQLite with **`Expression tree is too large (maximum depth 100)`**. It's only 19.7 KB
and 11 bound values. `can` for four actions needs **97 of the 100** bound values Durable Objects allow.

**Why it hurts.** The policy that reads naturally, the one in viborm's own folder-tree and team examples, can't
run on Durable Object SQLite or D1. A left-deep OR chain is as deep as it is long.

**Workaround.** The policy was rewritten around **actor facts** (`actorFacts()`):
- the level becomes data (`level in [action and above]`);
- the four grant kinds collapse into one `subjectKey in actor.subjects`;
- teamspace access comes from `actor.teamspaces[action]` instead of a join.

This required a derived `grant.subjectKey` column, and the Worker computes facts per request. The peak is now
63 bound values, and the plan's sketch is kept only as a failing reference
(`tests/workers/db/policy-limits.test.ts`).

**Fix wanted.**
- Compile level implication **once**, as a level comparison (`level >= ?`) or a CASE over the level, not by
  duplicating bodies.
- Emit **balanced** OR/AND trees, so depth grows as log(n), not n.
- Hoist repeated subqueries into a CTE.
- Let the compiler know the target's limits (depth 100, 100 bound values, 100 KB), and fail at policy
  definition time with a clear message, not at the first write in production.

## 5. `$as(actor)` is expensive to build

**What happens.** `db.$as(facts)` snapshots the facts and wraps every model. In the Workspace DO, building it was
**about half of `apply()`'s CPU** per commit (`docs/spikes/p4-scale.md`).

**Why it hurts.** A Durable Object serves many actors per second on one thread, and every commit pays the cost.
At 1,000 tabs, commit CPU is what limits latency.

**Workaround.** Governed clients are cached per set of facts (`AccessService.governed`), and the property
registry is handed to transactions (`primeRegistry`).

**Fix wanted.** Make `$as` cheap: lazy per-model wrappers, a compiled policy reused across actors, and the actor
bound as parameters instead of rebuilt into the client.

## 6. Raw SQL bypasses the policy, and there is no governed raw surface

**What happens.** `$queryRawUnsafe` under `$as` runs as the base client. The plan accepts this for the query
engine ("raw SQL bypasses viborm permissions … it must intersect every result with the actor's visibility
set"), but every workaround above also lands in raw SQL.

**Fix wanted.** A governed raw helper that injects the policy predicate of a model as a SQL fragment, for
example `` sql`… WHERE ${tx.page.$visible('read')}` ``. Hand-tuned queries such as the engine, FTS5 joins and
the live loop could then stay governed instead of re-intersecting with a visibility set built separately.

## 7. No `WITHOUT ROWID`

**What happens.** The schema can't declare `WITHOUT ROWID`, which the plan requires for the typed EAV tables
(`p_text`, `p_num`, `p_date`, `p_ref`, `value_count`), clustered by `(prop, v, page)`.

**Workaround.** `ensureEavLayout` rebuilds those tables as `WITHOUT ROWID` in place after viborm's migration.
viborm's drift check doesn't notice, but any later viborm migration that recreates one of these tables silently
drops the option. The next wake restores it.

**Fix wanted.** A model option such as `.withoutRowid()` for SQLite, kept through table recreation and drift
checks.

## 8. No Durable Object SQLite driver

**What happens.** viborm ships SQLite drivers for sqlite3, libSQL, Bun SQLite and D1, but not for
`ctx.storage.sql`, the storage behind every Durable Object.

**Workaround.** `src/server/db/do-sqlite-driver.ts` (about 420 lines) was written in P0 and passes 33 of viborm's
own behaviour contracts (`tests/workers/db/`). It had to work around:
- **Transactions:** Durable Objects refuse `BEGIN`, `SAVEPOINT`, `COMMIT`, `ROLLBACK TO` and `RELEASE`.
  viborm issues them for nested transactions, and its SQLite migration lock uses `BEGIN IMMEDIATE`. The driver
  **intercepts these statements by regex** and maps each one to a pending `ctx.storage.transaction`, which is
  fragile. `transactionSync` can't be used, because viborm's engine is async.
- **Platform tables:** they're named `_cf_*` and answer PRAGMAs with `SQLITE_AUTH`. viborm filters them for D1
  only, so the driver **rewrites viborm's catalog query**. Its `SQLITE_MIGRATION_CAPABILITY` also claims the
  platform reserves no tables.
- **`PRAGMA busy_timeout`** is refused by the platform, so the driver answers it locally.
- **Error codes:** workerd errors carry no code, so the driver derives one from the message.
- **Foreign keys:** a pending write turns `PRAGMA foreign_keys = OFF` into a silent no-op, so the driver calls
  `ctx.storage.sync()` before table recreation.

**Fix wanted.** A first-party `viborm/durable-object` driver, with these points designed in rather than
intercepted:
- a transaction-frame API instead of SQL `SAVEPOINT`s;
- a migration lock that doesn't use `BEGIN IMMEDIATE`;
- `_cf_*` excluded by the capability;
- typed errors.

Our driver can serve as the starting point, together with its contract tests.

## 9. Smaller issues

- **`TransactionClient` is not exported.** Code that takes "a client or a transaction" has to derive the type
  by `Omit`-ting client-only members (`src/server/db/workspace.client.ts`). Please export it.
- **Transaction phase notifications are internal.** The cache and instrumentation extensions can't learn that
  a transaction committed or rolled back through a custom driver, so they assume "committed when the callback
  returns". This needs a driver-facing hook.
- **`viborm/ordering` pulls in the ORM client.** Importing the rank-key helpers in the browser brings the whole
  client with them, so `src/lib/shared/sort-keys.ts` re-implements the key grammar, with tests that it stays
  compatible. The key functions should live in a client-safe entry point.
- **`IN` lists over 100 OR-ed equalities** on different fields are refused before SQLite
  (`UnsupportedOperationError`). That's correct, but the policy author learns it at run time (see section 4).
- **Integers beyond ±2^53** lose precision on Durable Object reads, because workerd returns JS numbers.
  viborm could expose a BigInt read mode per column, where the platform allows it.
- **D1 has no interactive transactions** in viborm, so better-auth's adapter runs with `transaction: false`
  and multi-statement writes rely on `batch`. This is known, and the plan accepts it. It's listed here because
  it shapes the outbox design.

---

## Priorities

| # | Limitation | Effect on Flarion | Priority |
|---|---|---|---|
| 1 | Referenced rows must be readable | Page create and move bypass the policy | **High** (security surface) |
| 2 | Silent no-op governed writes | Extra `can` per write; bugs look like success | **High** |
| 3 | No additive table additions to an estate | 7 tables outside viborm, a hand-written D1 migration | **High** (blocks every feature that adds a table) |
| 4 | Policy duplicated per level, unbalanced trees | The plan's policy can't run; rewritten around facts | **High** (the canonical example fails) |
| 5 | `$as` cost | About half of commit CPU before caching | Medium (performance) |
| 6 | No governed raw SQL | Engine and live loop re-implement visibility | Medium |
| 7 | No `WITHOUT ROWID` | Layout patch outside migrations | Medium |
| 8 | No Durable Object driver | 420 lines of glue with regex interception | Medium (we maintain it) |
| 9 | Smaller issues | Type workarounds, duplicated rank code | Low |

Once 1 to 4 are fixed in viborm, Flarion can move page create and move, the seven bootstrap tables and the
policy's actor facts back to plain viborm, and most of the raw SQL outside the engine and FTS5 goes away.
