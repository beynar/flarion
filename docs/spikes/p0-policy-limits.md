# P0 spike: the permission policy against Durable Object SQLite limits

Question (plan, "Risks"): do the permission policy's largest reads fit the 100 bound parameters and 100 KB
per statement of Durable Object SQLite? Answer: **the plan's sketch does not, once it is a real policy; a
compact form of the same rules does, with room to spare.**

Everything below is measured by `tests/workers/db/policy-limits.test.ts` on real workerd SQLite (the
`TEST_SQL` object, our driver, viborm 1.12.1), on a seeded workspace of **4,000 pages**: 5 teamspaces
(open, closed, private; default levels read to full), 300 root pages, a branching tree, 16 chains 50 pages
deep (maximum depth 51), 300 grants of every kind. Numbers are the statement the driver sent to SQLite:
bound values (`params.length`), SQL size in bytes, wall time in local workerd (indicative, not production).

## Findings

1. **Reads are small, writes are the problem.** A governed `page.findMany` is one statement of 1 to 4 KB. The
   100 KB limit is never close (the largest statement measured is 19.7 KB).
2. **The sketch fails on a move.** Writing `parentId` needs `full` on the old row and the placement check on
   the new one; with the sketch's four copies of the access rule per level, the statement nests past SQLite's
   expression-depth limit (**100**, set by the platform) and fails with `Expression tree is too large
   (maximum depth 100)` (19.7 KB, 11 bound values: bytes and parameters are not what breaks). The same
   sketch needs **97 of 100** bound values to ask `can` for four actions of one row.
3. **Cause.** viborm computes the predicate for action `a` as the OR of the rule of every level at or above
   `a` (`levels: [read, comment, update, full]`), so `read` repeats the whole rule body four times, and each
   body carries an OR over four grant kinds and a nested teamspace/membership `EXISTS`. A left-deep OR chain
   is as deep as it is long, and subqueries add their depth to the statement's.
4. **Fixes, all in `src/server/db/policy.ts`:**
   - **The level is data.** `actions` declares no implication between levels and each action's body tests
     `level in [action and above]` (`grant.level`, `teamspace.defaultLevel`). `read` is two bodies instead of
     four (viborm's built-in "update grants read" edge remains).
   - **One flat share condition.** `grant.subjectKey` (`user:<id>`, `teamspace:<id>`, `workspace`,
     `public:<token>`, derived on write) is matched with `subjectKey in actor.subjects`, replacing the OR over
     four kinds and its teamspace join. The Worker builds `actor.subjects` per request (`actorFacts`).
   - **Teamspace access from actor facts** (`policy`, "flat"): `teamspaceId in actor.teamspaces[action]`, no
     join. The row-based form is kept as `joinedPolicy` for comparison and as a fallback.
   - Not needed at this size: `$exists`, constants in rows (the `in` lists above are the constants), and the
     `page_ancestor` closure table. The recursive ancestor walk is one `WITH RECURSIVE` per statement.

## Measurements (4,000 pages, bound values / SQL bytes / ms)

Limits: 100 values, 100,000 bytes, expression depth 100. `-` = statement fails.

| Statement | Sketch (plan) | `joinedPolicy` | `policy` (flat) |
|---|---|---|---|
| `page.findMany` visible set, member (1,643 pages) | 35 / 3,653 / 46 | 16 / 1,360 / 24 | 13 / 1,006 / 33 |
| same, guest (230 pages) | 31 / 3,477 / 25 | 13 / 1,351 / 25 | 6 / 911 / 21 |
| same, anonymous with share token (28 pages) | 12 / 1,303 / 43 | 5 / 915 / 24 | 5 / 835 / 23 |
| same, admin (4,000 pages) | 0 / 77 / 2 | 0 / 77 / 1 | 0 / 77 / 2 |
| `page.can('read')`, depth-50 page | 37 / 3,684 | 18 / 1,391 | 15 / 1,037 |
| `page.can` x4 actions, depth-50 page | **97** / 10,734 | 57 / 5,420 | 44 / 3,848 |
| same, member that also holds a share token | 12 / 11,706 | 61 / 5,432 | 48 / 3,860 |
| `page.findMany` with `$access`, 50 rows | 11 / 13,657 | 72 / 7,218 | 56 / 5,242 |
| tree window (`take 200`, ordered) | 36 / 3,756 / 17 | 17 / 1,463 / 16 | 14 / 1,109 / 15 |
| `teamspace.findMany` / `teamspaceMember.findMany` | 3 / 471 | 3 / 471 | 3 / 471 |
| `grant.findMany` (182 rows) | 35 / 4,024 | 16 / 1,732 | 20 / 1,623 |
| `page.create` (placement under an editable parent) | 32 / 4,124 | 25 / 3,127 | 35 / 3,780 |
| `page.update` title | 56 / 6,417 | 30 / 3,120 | 24 / 2,359 |
| `page.update` parentId (move, needs `full`) | **-** (depth 100) | 84 / 11,040 | 56 / 8,282 |
| `page.delete` | - (not reached) | 25 / 3,097 | 17 / 2,330 |

(The sketch's `$access` and share-token `can` rows report few values because viborm renders repeated
values as numbered parameters there; the bytes show the real size. Counts are what the driver passed to
SQLite, which is what the limit applies to. viborm also refuses a statement whose value list exceeds the
driver's declared capacity before it reaches SQLite.)

`policy` peak: 56 values (move, `$access`), 8.3 KB. The test pins it at 60 so a rule added in P2 that eats
the headroom fails loudly. `joinedPolicy` peaks at 84 and also passes (pinned at 90).

Scale: the visible set of the largest member took 33 ms at 4,000 pages and about 116 ms at 20,000 (linear:
one recursive ancestor walk per candidate row). That is why the plan caches the visibility set per actor and
only recomputes it on grant/move/membership changes.

## Equivalence

The test compares the three policies' visible sets for six kinds of actor (member, admin, guest, anonymous
with a share token, member with a token, teamspace owner): identical. It also checks the inheritance
semantics the compact form must keep: a share on an ancestor reaches the whole subtree at its level and
below (`comment` on the root: `read` and `comment` yes, `update` and `full` no, on a leaf), a revoked share
(`deletedAt`) stops counting, teamspace default levels and ownership map to the four levels.

## What this changes for P2 / the plan

- `grant` gains `teamspaceId` (a real foreign key; viborm policies traverse relations, not polymorphic ids)
  and `subjectKey`. The policy sketch assumed a `grant.teamspace` relation the data model lacked.
- The Workspace DO builds the actor with `actorFacts()` once per actor and caches it with the visibility set;
  a membership, default-level or grant change invalidates both. The policy no longer reads
  `teamspace_member` in SQL (`policy`), which is also what makes the actor's visibility set cheap to compute.
- A move is the statement to watch. Keep the rule of any action cheap; if a P2 rule adds a branch to every
  level, re-run this test. Past that, the closure table `page_ancestor(page, ancestor, depth)` replaces the
  `WITH RECURSIVE` with a plain join, at the price of rewriting rows for the whole subtree on every move.
- Raw SQL (the query engine, FTS5) bypasses all of this, as the plan already states.

## viborm facts learned on the way

- Real vocabulary (viborm 1.12.1): `{ actor: 'path' }` value, `{ actor: { path: v } }` condition, a relation
  valued by an action name is the target's predicate, `parent: { recurse: { depth: false }, self: true, some }`
  (depth is mandatory), `$exists: { model: where }`, `$if`. Declaring `actions` makes every action explicit,
  including `create: []`.
- `in` lists compile to `IN (?, ?, ...)` for short lists and to one `json_each(?)` value for long ones.
  Several `OR`ed equalities on different fields are separate values, so >100 of them is refused by viborm
  before SQLite with `UnsupportedOperationError`.
- A governed client reads `db.$as(actor).page.findMany(...)`, `can(action | actions[], where)` and
  `select: { $access: true }` (one boolean per action, plus `create`).
- Soft delete (`viborm/soft-delete`) was not composed with the policy in this spike (P2).

---

# P2 final numbers (Sync core)

The policy of `src/server/db/policy.ts` is final for P2. It is the compact `policy` of the spike plus the rules
the spike left out; `tests/workers/db/policy-limits.test.ts` still measures it (same 4,000-page workspace) and
now also covers the statements the Workspace DO really sends (`objects/workspace/access.ts`). Bound values /
SQL bytes, limits 100 / 100,000.

| Statement (final `policy`) | values / bytes |
|---|---|
| `page.findMany` visible set, member / guest / anonymous with token / admin | 13 / 1,035 &nbsp; 6 / 940 &nbsp; 5 / 835 &nbsp; 0 / 77 |
| same, member that also holds a share token | 14 / 1,038 |
| `page.can` x4 actions, depth-50 page | 44 / 3,970 (48 with a token) |
| visibility entry: `findMany(num, $access)` of every live page | 56 / 5,244 (61 with a token), 49 ms for 1,643 pages |
| `pageAccess`: `findFirst({ id, deletedAt: null }, $access)` | 58 / 5,266 (**63** with a token, the peak) |
| `can(ids)`: `id in 60 ids` with `$access` | 57 / 5,309 |
| dirty subtree recompute: `num in 60 nums` with `$access` | 57 / 5,297 |
| tree window (`take 200`) | 14 / 1,138 |
| `page.update` title / `parentId` move / `page.delete` | 24 / 2,409 &nbsp; 56 / 8,501 &nbsp; 17 / 2,380 |
| `page.create` (placement under an editable parent) | 35 / 3,839 |

The test pins the peak at 64 (it was 60 for the reads measured in P0); the largest statement is 63 values, 36
under the limit. The plan's sketch still fails on a move (expression depth 100) and is kept only to show it.

## What P2 changed in the rules

- **Private section.** The plan's `{ teamspaceId: null, createdById: me }` is applied to the ROOT of the chain
  (`parentId: null` too) inside the same ancestor walk as the shares, so the creator of a Private root owns the
  whole branch and nobody gains ownership of a page by adding it under someone else's branch.
- **`create`** (placement): `{ parent: 'update' }`, or a root in a teamspace where the caller holds `update`
  (`actor.teamspaces.update`; the sketch said "member": a read-only member could add pages), or any root for
  admins, or a root in the caller's own Private section (never guests).
- **Guests** hold no teamspace (`actorFacts` ignores membership rows for them; demoting a member to guest drops
  them), and cannot read teamspaces.
- **Teamspace models**: `read` (open and closed for non-guests, private for members), `update, full` (owners),
  `create` (non-guests); `teamspaceMember`: `read`, `create` (owners add anyone, a non-guest joins an open
  teamspace as a member), `update` (owners), delete is `leave` (owners, or the member themselves); `grant` as in
  the plan.
- **Bookkeeping models** (EAV tables, registry, collections, views, change log, mutation ids, meta, links, open
  rooms, `member` read-only) are open under `$as`: unlisted models are refused by `$as`, and a whole commit has
  to run in one governed transaction. The Workspace DO's code asserts the page-level right first
  (`authorize.ts`), and everything it writes goes through that path.

## viborm facts learned in P2

- Unlisted models are **refused** under `$as` (`ForbiddenError`): list them, even as `{ read: true, ... }`.
- A governed **`update` or `delete` that matches no row the actor may change does nothing, silently**; only
  `create` throws. Writes that matter ask `can`/`assert` first (`authorize.ts`, `teamspaces.ts`).
- A governed **write that references a row the actor cannot read is refused**: `page.create` with a `teamspaceId`
  needs read on that teamspace, which a guest, or a member shared one page of a private teamspace, lacks. Page
  creation and moves are therefore raw INSERT/UPDATE statements after the same checks the policy states
  (`createPage`, `movePage`), covered by the matrix test.
- `$access` selections and `can` run inside a governed `$transaction`; `tx.page.can([...])` is one statement.

## The matrix (`tests/workers/permissions/`)

`model.ts` is the plan's rules in 50 lines of plain TypeScript, written without the policy; `scenario.ts`
generates workspaces (8 users: owner, admin, 4 members, 2 guests; 3 to 5 teamspaces of every privacy and default
level; 28 to 52 pages in a random tree with trashed subtrees; grants of every kind, some revoked); the callers
are every user plus anonymous visitors with no token, a wrong token, a live public link and a revoked one, and a
member that also holds a token.

- **Static** (30 seeds): `can` at all four levels for every page, `pageAccess` on a sample and `visibleNums`
  equal the model for every caller.
- **Incremental** (12 seeds, 30 steps each): with every set hot in memory, random grants, revokes, moves across
  teamspaces and into Private, page creation by any role (the outcome, `FORBIDDEN` or `not_found`, is compared
  too), new teamspaces, teamspace membership changes, role changes, member removals, trashes and restores go
  through the DO's API; after every step the lazily invalidated sets of all callers equal a fresh evaluation of
  the model, and the access answers of a rotating subset do too.
- A share on a 720-page subtree (more than `MAX_SUBTREE`) takes the full-rebuild fallback and still matches.
