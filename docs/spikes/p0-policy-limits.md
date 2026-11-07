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
