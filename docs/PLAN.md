

# Notion Clone on Cloudflare — Implementation Plan
 · 

## Overview
Build a Notion-class workspace as one SvelteKit project deployed as a single Cloudflare Worker: pages of blocks, databases that are live queries over any page, real-time collaboration, sharing, trash and basic AI.
**Goals**
- Every Notion block that needs no third-party integration, plus nested pages, mentions, comments and page history.
- Databases as saved queries over all pages, not only their children, with properties stored in typed EAV tables.
- Everything live: the sidebar, page headers, every database view and comments update for all collaborators without a refresh.
- Notion-style teamspaces, and permissions inherited through the page tree, written once as a viborm policy.
- Soft delete everywhere, with a 30-day trash and a complete purge.
- Only Cloudflare primitives, one repository, one deploy.
**Out of scope**
- Integrations: OAuth connections, synced external databases, outbound webhooks, Slack or GitHub previews.
- Automations or buttons that call outside services, native mobile apps (responsive web only) and custom domains for published pages.
**Key decisions**
- One Workspace Durable Object per workspace owns the page tree, properties, views, permissions, the change log and live queries.
- One Page Durable Object per page hosts its edytor room. Page bodies never pass through the Workspace Durable Object.
- D1 holds only global data: accounts, passkeys, workspaces, memberships, invites and API tokens.
- Writes go through oRPC. Live data arrives over one workspace WebSocket as diffs tagged with a sequence number.
- viborm, with its permissions and soft-delete extensions, is the only path to data. Its Durable Object SQLite driver is the first thing to build.

## Stack and constraints
Every piece is either one of your libraries or a Cloudflare primitive. The constraints below shape the design more than any library choice.
| Layer | Choice | Role here | 
| App | SvelteKit, Svelte 5 | Routes, UI, client-rendered app shell | 
| Deploy glue | [sveltekit-cloudflare-worker](https://github.com/beynar/sveltekit-cloudflare-worker) | `src/worker.ts` adds Durable Objects, Workflows, queue and cron handlers to the SvelteKit Worker | 
| UI | [entasis](https://entasis.beynar.workers.dev/) | Shell, sidebar, tree, data table, kanban, calendar, Gantt, menus, AI chat | 
| Editor | [edytor](https://edytor.dev/) | Blocks on a Yjs v14 engine, presence, offline copy, comments, history, Durable Object room | 
| ORM | [viborm](https://viborm.dev/) with permissions, soft delete and ordering | Every read and write, in D1 and in Durable Object SQLite | 
| API | oRPC | Private RPC, public OpenAPI, WebSocket transport with hibernation | 
| Auth | better-auth with `@better-auth/passkey` | Passkey-only sign-up and sign-in | 
| Platform | Workers, Durable Objects (SQLite), D1, R2, Queues, Workflows, KV, Workers AI, AI Gateway, Vectorize, Email Service, Images, Turnstile, Rate Limiting, Analytics Engine | Compute, state, files, jobs, AI, mail, metrics | **Constraints that drive the design**
- **No viborm driver for Durable Object SQLite yet.** viborm's SQLite drivers are sqlite3, libSQL, Bun SQLite and D1. A driver over `ctx.storage.sql` is phase 0 work.
- **D1 runs atomic batches only in viborm.** The D1 driver has no interactive transactions and refuses effectful migrations, so D1 migrations ship as generated SQL applied by Wrangler.
- **Raw SQL bypasses viborm permissions.** The database query engine uses raw SQL for speed, so it must intersect every result with the actor's visibility set.
- **Durable Object limits.** Each object gets 10 GB of SQLite, 128 MB of memory and one thread, with a soft limit near 1,000 requests per second, 100 bound parameters per statement and up to 32,768 hibernatable WebSockets.
- **Dev-mode deadlock.** Durable Object RPC called from SvelteKit server code deadlocks under `vite dev`, so all Durable Object access lives in `src/worker.ts`.
- **edytor quotas.** A room defaults to a 2 MiB document quota and 50 sync messages per second per socket. Raise the document quota for long pages.
- **oRPC versions.** oRPC v2 is in beta and moves hibernation support into `@orpc/hibernation`. Pick v1 or v2 in phase 0 and keep it for the project.
- **Email Sending is in beta.** Sending to arbitrary recipients needs the Workers Paid plan.

## System architecture
Every request enters one Worker, which routes it to a Durable Object, D1, R2 or SvelteKit. The Workspace Durable Object is the hub: it holds a workspace's live state and talks to every Page Durable Object.
[Diagram: architecture · one Worker, two Durable Object classes, D1 and platform services]

The browser keeps three kinds of connection: oRPC over HTTPS, one socket to its workspace's Durable Object and one edytor socket per open page. Page DOs send text and links to the Workspace DO on save; the Workspace DO pushes access changes back.

## Project structure
One SvelteKit repository builds one Worker. `src/worker.ts` routes API, socket and file traffic before SvelteKit and exports both Durable Object classes, the queue consumer, the cron handler and the Workflows.
```
notion-clone/
├─ src/
│  ├─ worker.ts                 # fetch router + exported DOs, queue, scheduled, Workflows
│  ├─ server/
│  │  ├─ auth.ts                # better-auth + passkey plugin, viborm adapter on D1
│  │  ├─ rpc/
│  │  │  ├─ contract.ts         # oRPC contract shared with the client
│  │  │  ├─ private/            # app procedures, session auth
│  │  │  └─ public/             # /v1 OpenAPI procedures, token auth
│  │  ├─ db/
│  │  │  ├─ global.schema.ts    # D1 models
│  │  │  ├─ workspace.schema.ts # Workspace DO models
│  │  │  ├─ policy.ts           # viborm permissions policy
│  │  │  └─ do-sqlite-driver.ts # viborm driver over ctx.storage.sql
│  │  ├─ objects/
│  │  │  ├─ workspace/          # WorkspaceDO: mutations, EAV, ACL, live queries, FTS5
│  │  │  └─ page/               # PageDO: edytor attachRoom, validate, onSave
│  │  ├─ engine/                # filter compiler, IVM, formulas, rollups, bitmaps
│  │  ├─ ai/                    # prompts, retrieval, Workers AI calls
│  │  ├─ queues/                # index, embed, AI property, email consumers
│  │  └─ workflows/             # import, export, purge, bulk property changes
│  ├─ lib/
│  │  ├─ shared/                # block kinds and semantics, filter AST, property codecs
│  │  ├─ client/                # oRPC client, workspace socket, runes store, IndexedDB
│  │  └─ components/            # page header, property editors, views, editor plugins
│  └─ routes/
│     ├─ (auth)/                # login, signup, invite/[token]
│     ├─ (app)/[ws]/            # +layout.ts: export const ssr = false
│     │  ├─ [page]/             # page or full-page database
│     │  ├─ trash/ and settings/
│     └─ (public)/share/[token]/ # published pages
├─ migrations/d1/               # generated SQL, applied by wrangler d1 migrations
├─ wrangler.jsonc
└─ vite.config.ts               # plugins: [sveltekit(), cloudflareWorker()]
```

**Request routing in ****`src/worker.ts`**, in this order:
- `/api/auth/*` goes to the better-auth handler.
- `/rpc/*` goes to the oRPC `RPCHandler` (private API).
- `/v1/*` goes to the oRPC `OpenAPIHandler` (public API).
- `/ws/:workspaceId` checks the session, then upgrades into the Workspace Durable Object.
- `/rooms/:pageId` goes through edytor's `routeDocumentSocket` into the Page Durable Object.
- `/files/*` streams uploads and downloads to R2 after a permission check.
- Everything else returns nothing, so the request falls through to SvelteKit.
**Bindings**
| Binding | Type | Purpose | 
| `DB` | D1 | Accounts, passkeys, workspaces, memberships, invites, API tokens, share links | 
| `WORKSPACE` | Durable Object, SQLite (`WorkspaceDO`) | Per-workspace tree, properties, views, grants, change log, live queries, search | 
| `PAGE` | Durable Object, SQLite (`PageDO`) | Per-page edytor room | 
| `FILES` | R2 | Uploads, covers, page snapshots, history, exports, backups | 
| `JOBS` | Queue | Indexing, embeddings, AI properties, email | 
| `IMPORT`, `EXPORT`, `PURGE` | Workflows | Long jobs that outlive one request | 
| `CACHE` | KV | Bookmark unfurls, published-page HTML | 
| `AI` | Workers AI, through AI Gateway | Generation and embeddings | 
| `VECTORS` | Vectorize | Page chunks for semantic search | 
| `EMAIL` | Email Service (`send_email`) | Invites, verification, recovery | 
| `RL_AUTH`, `RL_API` | Rate Limiting | Auth endpoints and public API | 
| `METRICS` | Analytics Engine | Latency, fan-out, storage gauges | **Environments:** local dev under `vite dev` with workerd, Miniflare D1 and R2; then `staging` and `production` as Wrangler environments. Both Durable Object classes are declared in `new_sqlite_classes` migrations from the first deploy.

## Authentication
Users sign up and sign in with passkeys only. better-auth's passkey plugin supports passkey-first onboarding when `registration.requireSession` is `false`: a `resolveUser` hook creates or loads the user from an opaque `context` the client sends.
**Sign-up**
- The visitor enters a name and email, passes Turnstile, and the server returns a signed, single-use registration token.
- The client calls `authClient.passkey.addPasskey({ context: token, createSession: true })`.
- The server's `resolveUser` checks the token and returns the user. To avoid orphan users when the ceremony fails, create the user in `registration.afterVerification` instead.
- The passkey is stored, the session cookie is set, and the user lands on "Create a workspace" or on the invite they came from.
- A verification email goes out through Email Service. Inviting others and account recovery require a verified email.
**Sign-in** uses `authClient.signIn.passkey({ autoFill: true })` with an `autocomplete="username webauthn"` input, so the browser offers the passkey without typing anything. Set `userVerification: "required"` and `residentKey: "required"`.
**Passkey management:** settings list, rename and delete passkeys. Deleting the last one is refused.
**Recovery without passwords**
- Encourage a second passkey at sign-up (another device or a security key). Synced passkeys from Apple, Google or a password manager cover most lost-device cases.
- A "Lost your passkey?" flow emails a single-use link valid for 15 minutes. It opens a session that can only register a new passkey, then revokes all other sessions.
- Workspace owners can remove a member's passkeys and resend that recovery link.
**Sessions and identity**
- Sessions live in D1, with better-auth's cookie cache so most requests skip the D1 read.
- Every request builds an actor `{ userId, sessionId, workspaceId, role }`. The role comes from the D1 membership, cached in the Workspace Durable Object.
- The workspace socket authenticates with the session cookie at upgrade, so `allowedOrigins` is set on every socket route.
- edytor rooms take a signed token of about 10 minutes in `params`. `authorize` returns its `expiresAt`, and the provider refreshes it when the room closes the socket with `4401`.
**Database adapter:** better-auth needs an adapter. Write a small viborm adapter with `createAdapterFactory` so auth tables share the D1 schema and migrations. The fallback is better-auth's Kysely adapter on a D1 dialect.
**Invites:** an owner or admin creates an invite row (email, role, token hash, expiry) and Email Service sends the link. Accepting signs the user up or in, then inserts the membership in one D1 batch.
**Hardening:** rate-limit `/api/auth/*` with the `RL_AUTH` binding, set the relying party ID to the app's registrable domain, and keep the challenge cookie `SameSite=Lax` and `Secure`.

## Data model
Three stores, each with one job: D1 for global identity and the workspace directory, one Workspace Durable Object for a workspace's structure, properties and access, and one Page Durable Object per page for its body.
**Where each piece of a page lives**
| Data | Store | Why | 
| Body blocks, inline marks, comments, cursors | Page DO (edytor) | CRDT merges, offline edits, per-page history | 
| Title, icon, cover, parent, order | Workspace DO, `page` row | Sidebar, breadcrumbs, search and views read them without opening the page | 
| Properties | Workspace DO, typed EAV | Filters and sorts across all pages | 
| Who can see it | Workspace DO, `grant` rows, teamspace membership and the tree | Inherited permissions are one query | 
| Files | R2 | Size; served after a permission check | The title is a last-writer-wins property edited live with a 300 ms debounce, not CRDT text. Simultaneous title edits are rare, and one source of truth beats syncing a CRDT title into the index. Revisit if users hit conflicts.
**D1 (global, viborm D1 driver)**
| Model | Key fields | 
| `user`, `session`, `passkey`, `verification` | better-auth tables | 
| `workspace` | id, name, slug, icon, createdAt, deletedAt | 
| `membership` | workspaceId, userId, role (owner, admin, member, guest), joinedAt | 
| `invite` | id, workspaceId, email, role, tokenHash, expiresAt, acceptedAt | 
| `apiToken` | id, workspaceId, userId, name, tokenHash, scopes, expiresAt, lastUsedAt, revokedAt | 
| `publicShare` | token, workspaceId, pageId, createdBy, revokedAt | **Workspace Durable Object (SQLite, viborm through the new driver)**
```sql
-- pages: tree, identity, soft delete
page(id TEXT PRIMARY KEY, num INTEGER UNIQUE,   -- dense integer for bitmaps
     parent_id, rank,                            -- viborm ordering key among siblings
     teamspace_id,                               -- null = creator's Private section; copied down the subtree
     title, icon, cover, is_database,
     created_by, created_at, updated_by, updated_at,
     deleted_at, deleted_by, trash_root,         -- soft delete
     props_json)                                 -- readable copy of all values

-- property registry, shared by the whole workspace
property(id, num, name, type, config_json, deleted_at)

-- typed EAV, clustered by property (WITHOUT ROWID)
p_text(prop, v, page, PRIMARY KEY (prop, v, page))   -- v = normalized sort key
p_num (prop, v, page, PRIMARY KEY (prop, v, page))
p_date(prop, v, v_end, page, PRIMARY KEY (prop, v, page))
p_ref (prop, v, page, PRIMARY KEY (prop, v, page))   -- options, people, relations, files
-- each table also has INDEX (page, prop); computed rows carry computed = 1

-- databases
collection(id, page_id, source_ast, shown_props, defaults_json)
collection_member(collection_id, page_id, rank)       -- hand-picked rows, manual order
view(id, collection_id, type, name, filter_ast, sorts, group_by, columns_json, rank)

-- teamspaces and access
teamspace(id, name, icon, description, privacy,      -- open | closed | private
          default_level, created_by, deleted_at)
teamspace_member(teamspace_id, user_id, role, rank)  -- owner | member; rank = sidebar order
grant(id, page_id, subject_kind, subject_id,         -- user | workspace | teamspace | public
      level, token, created_by, deleted_at)
member(user_id, role)                                -- mirror of D1 membership

-- sync and derived data
change(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts, actor, kind, page, prop, old_json, new_json)
link(from_page, to_page, kind)                         -- mentions, page links, subpages
search USING fts5(page_num UNINDEXED, field, text)
open_room(page_id, opened_at)                          -- pages with live edytor sockets
```

- `page.num` is assigned once and never reused, so bitmaps and posting lists stay valid.
- `props_json` is written in the same transaction as the EAV rows. Views read it for display; the EAV tables serve filters and sorts.
- Tenant isolation is physical: one object holds one workspace, so no policy needs an organization filter.
**Page Durable Object (SQLite, owned by edytor)**
- `attachRoom` creates its own tables (`edytor_rows`, `edytor_replicas`, `edytor_meta`, plus history and moves tables) beside one app table, `page_meta(page_id, workspace_id)`.
- `onSave` writes the CRDT update and replica owners to R2 as the durable copy, and enqueues a deduplicated indexing job; the queue consumer feeds the Workspace DO in batches.
- `onLoad` restores from R2 for a room that stores nothing, so a page survives the loss of its object's storage.

## Permissions
Access is one viborm permissions policy in the Workspace Durable Object. A page's access is inherited from its ancestors and granted to users, teamspaces, the whole workspace or a public link, at four levels that map directly onto edytor's room access.
| Page level | Allows | viborm action | edytor `access` | 
| Full access | Everything below, plus share, move and delete | `full` | `write` | 
| Can edit | Edit body and properties, create subpages | `update` | `write` | 
| Can comment | Read and comment | `comment` | `comment` | 
| Can view | Read | `read` | `read` | **Workspace roles** come from D1: owners and admins hold `full` on every page, members join teamspaces and see pages shared with them, and guests see only pages granted to them directly.
**Teamspaces** are a first-class model in the Workspace DO, as in Notion.
- A teamspace has a name, icon, privacy (open, closed or private) and a default access level for its members. Its owners manage members and settings.
- Every page belongs to one teamspace or to its creator's Private section. `page.teamspace_id` is copied onto every page of a subtree and rewritten when a subtree moves to another teamspace.
- Members get the teamspace's default level on all its pages, and owners get full access. Page grants add access on top: a guest, another person, another teamspace or a public link.
- Open teamspaces are listed to every workspace member, who can join in one click. Closed ones are listed but joined by invitation. Private ones are invisible to non-members.
- Grants only add access. To hide part of a teamspace, move it to a private teamspace or to the Private section.
- The sidebar has three sections: Teamspaces, Shared and Private.
**Policy sketch** (follows the folder-tree and team examples in viborm's permissions docs; check exact syntax while building):
```ts
const isMember = { members: { some: { userId: { actor: "userId" } } } };
const isOwner  = { members: { some: { userId: { actor: "userId" }, role: "owner" } } };

// members get their teamspace's default level (teamspace_id is copied onto every page)
const viaTeamspace: Rule = (level) => ({ teamspace: { is: { defaultLevel: level, ...isMember } } });

// explicit shares on the page or any ancestor
const granted: Rule = (level) => ({
  grants: { some: { level, OR: [
    { subjectKind: "user", subjectId: { actor: "userId" } },
    { subjectKind: "workspace", AND: [{ actor: { guest: false } }] },
    { subjectKind: "teamspace", teamspace: { is: isMember } },
    { subjectKind: "public", token: { actor: "shareToken" } },   // optional actor value
  ] } },
});

const access = [
  { actor: { admin: true } },
  viaTeamspace,
  { teamspaceId: null, createdById: { actor: "userId" } },      // Private section
  { parent: { recurse: { depth: false }, self: true, some: granted } },
];

export const policy = permissions({
  actor: v.object({ userId: v.optional(v.string()), admin: v.boolean(),
                    guest: v.boolean(), shareToken: v.optional(v.string()) }),
  levels: ["read", "comment", "update", "full"],
  models: {
    page: {
      operations: { delete: "full" },
      "read, comment, update": { OR: access },
      full: { OR: [...access, { teamspace: { is: isOwner } }] },
      create: { OR: [
        { parent: "update" },
        { parentId: null, teamspace: { is: isMember } },
        { parentId: null, teamspaceId: null, createdById: { actor: "userId" } },
      ] },
      fields: { parentId: { write: "full" }, teamspaceId: { write: "full" } },
    },
    teamspace: {
      read: { OR: [{ AND: [{ privacy: { in: ["open", "closed"] } }, { actor: { guest: false } }] },
                   isMember] },
      "update, full": isOwner,
      create: { actor: { guest: false } },
    },
    teamspaceMember: { read: { teamspace: "read" }, "create, update": { teamspace: "update" } },
    grant: { read: { page: "read" }, "create, update": { page: "full" },
             operations: { delete: "update" } },
  },
});
```

A missing `shareToken` or `userId` only disables the alternative that reads it, so anonymous visitors match public links and nothing else.
**Enforcement points**
- **Every Workspace DO call runs on ****`db.$as(actor)`****.** The base client is reserved for migrations, purge and system jobs, each after an explicit `assert`.
- **edytor rooms.** The Worker's `authorize` asks the Workspace DO for `page.can(["read", "comment", "update"], { id })` and returns the matching `access`, with a 10-minute `expiresAt`.
- **Live queries, search and AI.** Each actor gets a visibility set: the `num` of every page `page.findMany` returns under `$as`. It is cached in memory, ANDed into every result, and recomputed lazily, only for affected actors and subtrees, when a grant, a move, a teamspace membership or a workspace membership changes.
- **Access changes reach open rooms.** On a grant or move, the Workspace DO walks the affected subtree, keeps the pages listed in `open_room`, and calls `setAccess(userId, level)` or `closeUser` on each Page DO.
- **Files** are served only after `can("read")` on the page that owns them.
- **UI.** Tree and page reads include `$access`, so buttons and menus show only what the user may do.
**Costs to watch**
- The recursive ancestor walk runs per row. If profiling shows it hurting, keep a closure table `page_ancestor(page, ancestor, depth)` updated on every move and point the rule at it.
- Durable Object SQLite allows 100 bound parameters per statement. Keep constants in rows, prefer `$exists` for checks about the actor, and select only the fields a view needs.

## Real-time sync
Each tab holds one WebSocket to its workspace's Durable Object for structure and databases, plus one edytor socket per open page. Every write is committed, logged with a sequence number and pushed as diffs to exactly the views it changes.
| Channel | Endpoint | Carries | Built with | 
| Workspace socket | `/ws/:workspaceId` to WorkspaceDO | Sidebar tree, page headers, property values, view windows, presence, notifications | oRPC WebSocket `RPCHandler` with the hibernation plugin | 
| Page room | `/rooms/:pageId` to PageDO | Block CRDT updates, cursors, comments | edytor provider and `attachRoom` | 
| HTTP | `/rpc` | Mutations, one-shot reads, AI streams | oRPC `RPCHandler` | **Write path**
- The client applies the mutation to its store as an optimistic layer and calls `ws.mutate({ mid, ops })` over oRPC.
- The Worker authenticates, builds the actor and calls `WorkspaceDO.apply(actor, ops)` over Durable Object RPC.
- The object validates ops against the property registry, then writes through `db.$as(actor)` and appends `change` rows inside one `transactionSync`. The last row's `seq` is the commit's sequence number.
- The subscription loop finds affected views through the property-to-subscription index and sends each socket one batched diff tagged with `seq`.
- The procedure returns `{ seq }`. The client drops the optimistic layer once its socket has delivered that `seq`, or rolls it back with a toast if the call failed.
Ops are fine-grained so concurrent edits merge: `setProp`, `addOption` and `removeOption` for multi-values, `move` with an ordering key, `create`, `trash`, `restore`. Conflicts on one property resolve by commit order.
**Subscriptions**
- Kinds: `tree` (expanded branches of the sidebar), `page` (header and properties of open pages), `view` (a database view window) and `backlinks`.
- On subscribe, the object compiles the query, intersects it with the actor's visibility set, sends a snapshot `{ rows, total, seq }` and registers the subscription by the properties it filters, sorts and shows.
- Diff ops are `add` at an index, `remove`, `move` to an index, `update` of one value, and `count`.
- Identical queries with the same visibility scope share one subscription, so a hundred people on one board cost one evaluation.
- Scrolling grows the window with `window({ id, limit })`. Rows beyond the window are never sent.
- A socket's attachment holds only its id and actor, because attachments are capped at 2,048 bytes. Its subscriptions live in a table, so the object rebuilds them after hibernation.
**Reconnect:** the client sends its last `seq`. The object replays later `change` rows through the subscription loop, or sends fresh snapshots if that `seq` is older than the log's retention of 7 days.
**Presence:** the workspace socket carries who is on which page (avatars in the sidebar and page header), kept in memory and never stored. Cursors and selections inside a page stay in edytor's presence.
**Between Durable Objects**
- Page to workspace: on each `onSave`, the Page DO enqueues a deduplicated job. The queue consumer batches up to 100 pages into one Workspace DO call carrying plain text, outline, links, mentions and last-edited time, at most once per page every 30 seconds.
- Workspace to page: access changes (`setAccess`, `closeUser`), trashing (close every socket) and restore.
**Offline:** page bodies are fully editable offline through edytor's IndexedDB copy. Workspace metadata is cached read-only in IndexedDB for instant boot. Property edits, moves and new pages need a connection, and the UI disables them while offline.

## Pages and blocks
Page bodies are edytor documents, one Page Durable Object each through `attachRoom`. edytor's bundled plugins cover almost every Notion block; only the database view and breadcrumb blocks are new.
| Notion block | edytor plugin | Notes | 
| Text, headings 1 to 3, bulleted and numbered lists, to-do, toggle, toggle headings, quote, callout, divider | `createRichTextPlugin` | On by default | 
| Code | `createCodePlugin` | Render `mermaid` code with entasis Mermaid | 
| Image | `createImagePlugin({ upload })` | Upload goes to R2 | 
| Video, audio, file, PDF | `createVideoPlugin`, `createAudioPlugin`, `createFilePlugin` | PDFs open in entasis Document viewer | 
| Embed | `createEmbedPlugin` | Allowlisted players only, no OAuth | 
| Web bookmark | `createBookmarkPlugin({ unfurl })` | Unfurl fetched by the Worker, cached in KV | 
| Columns | `createColumnsPlugin` |  | 
| Simple table | `createTablePlugin` |  | 
| Subpage | `createPagePlugin` | Create, open and name through the workspace API | 
| Page link `[[` and mention `@` | `createPageLinkPlugin`, `createMentionPlugin` | People, pages and dates; date mention is a custom inline block | 
| Table of contents | `createTocPlugin` |  | 
| Equation, block and inline | `createEquationPlugin` |  | 
| Comments | `createCommentsPlugin` | Threads stored by the room | 
| AI drafts | `createSharedSuggestionsPlugin` | AI answers stream in as suggestions | 
| Linked or inline database | custom void block `database_view` | `data: { collectionId, viewId, localFilter }`, renders a live view | 
| Breadcrumb | custom void block | Reads ancestors from the workspace store | Editing chrome comes from bundled plugins too: block handles, block menu, slash menu, selection toolbar, markdown shortcuts, arrow moves, find and replace, and marquee selection. Their snippets render entasis Menu, Popover and Command components, and the Notion theme stylesheet is the starting look.
**Shared block roles.** Custom kinds declare their roles in one `kinds.ts`. The client spreads them into the plugin, and the Page DO passes `mergeSemantics(defaultSemantics, semanticsOf(customKinds))` as `semantics`.
**Page header** (outside the editor, bound to the workspace store): icon picker, cover with reposition, title input, the property panel, a backlinks count from the `link` table, and presence avatars.
**Page operations**
- **Create:** the Workspace DO inserts the `page` row. The Page DO starts on first open, and `onLoad` seeds a template's JSON or nothing.
- **Duplicate:** read the source with the room's `read()` and seed the new room with that JSON through `onLoad`. A fresh document has no shared history, so seeding from JSON is safe.
- **Move blocks to another page** and "Turn into page": edytor's cross-document moves (`exportBlocks`, `importBlocks`, `commitMove`).
- **Lock page:** edytor locks with `subtree: true`, and `bypass` for users with full access.
- **History:** edytor history kept in R2 through `r2History`, shown in its history panel, compared with entasis Diff.
- **Export:** Markdown and HTML from `edytor/export` on the server.
**Page DO settings:** raise `maxDocumentBytes` from its 2 MiB default to 16 MiB and warn the user at 80%. Use `validate` to refuse edits from users whose access was lowered mid-session.

## Databases
A database is a collection: a saved query over every page in the workspace, plus optional hand-picked members. Its views filter, sort, group and display properties stored in typed EAV tables, and every view is a live subscription.
**Collections**
- Properties belong to the workspace registry. A collection chooses which of them it shows, so "Status" means the same thing everywhere.
- Membership is a filter AST (`tag = Task`, `parent = this page`, `Project contains X`), hand-picked `collection_member` rows, or both. A classic Notion child database is `parent = the database page`.
- A new row created from a view gets values that satisfy the view's filter, as Notion does, and the collection's default parent.
- A `database_view` block can show any collection's view on any page, with an extra local filter.
**Views and their entasis components**
| View | entasis component | Driven by | 
| Table | Data table | Columns, widths, wrap, frozen first column | 
| Board | Kanban | Group by select, status, person or checkbox | 
| List | Sortable list | Shown properties per row | 
| Gallery | Grid and Card | Cover from a files property or the first image | 
| Calendar | Event calendar | A date property | 
| Timeline | Gantt chart | A date range, or two date properties | **Property types**
| Type | Storage | Filters | 
| Title | `p_text` and `page.title` | contains, starts with, is empty | 
| Text, URL, email, phone | `p_text` | contains, is, is empty | 
| Number | `p_num` | equals, compare, is empty | 
| Select, status | `p_ref` (option id) | is, is not, is empty | 
| Multi-select | `p_ref`, one row per option | contains, does not contain | 
| Date, with optional end | `p_date` | is, before, after, within a relative range | 
| Person | `p_ref` (user id) | contains, is me | 
| Checkbox | `p_num` 0 or 1 | is | 
| Files and media | `p_ref` (file id) | is empty | 
| Relation | `p_ref` (target page `num`) | contains, is empty | 
| Rollup, formula | computed rows in the matching table | by result type | 
| Created and edited time and by | `page` columns | date and person filters | 
| Unique ID | `p_num`, prefix in config | equals | 
| AI property | computed `p_text` | text filters | The reverse side of a relation costs nothing: a range scan of `p_ref` on `(prop, v)` lists every page pointing at a target, so no mirrored rows are stored. Option ids, not labels, are stored, so renaming an option is one config write.
**Query pipeline**
- Compile the filter AST (AND and OR groups, three levels deep) and order its conditions by selectivity, using per-value counts kept on write.
- Turn each condition into an indexed range scan over its typed table, or a bitmap once bitmaps exist.
- Intersect with the collection's members, the actor's visibility set and the live-pages set, which excludes tombstones.
- Sort: walk the sort property's index when it is the first sort key; otherwise keep the top rows with a heap over a column of values.
- Group for boards and grouped lists, with per-group windows and counts.
- Return the window and total, and register the subscription with the properties it filters, sorts and shows.
**Live updates (incremental view maintenance).** On a write, only subscriptions that reference the changed property are checked. A page that enters a view is added at its sorted position, one that leaves is removed and the window refilled, one whose sort value changed moves, and anything else gets a cell update. Bulk edits run the loop once and send one message per socket.
**Relations, rollups and formulas**
- A `dependency(source_prop, target_prop, via_relation)` table is built when a rollup or formula is defined. Cycles are refused at definition time.
- A write to a source property finds dependent pages through the reverse relation scan, recomputes their values and writes computed rows, which flow through the same live loop.
- Formulas use a Notion-like language parsed in `lib/shared` into an AST. The server evaluates it on write; the client evaluates it for previews.
- Formulas that read `now()` are recomputed hourly by the object's alarm and cannot be a view's primary sort.
**Imports:** CSV import runs as a Workflow in chunks, infers property types from a sample, and creates pages and properties through the same mutation path.

## Soft delete and trash
Deleting a page tombstones it and its whole subtree with one shared `deletedAt`, hides it everywhere, keeps it in Trash for 30 days, then purges every trace of it.
**Setup:** viborm's `softDelete` extension covers `page`, `property`, `collection`, `view`, `grant` and `teamspace` in the Workspace DO, and `workspace` and `membership` in D1. Each model gets nullable `deletedAt` and `deletedById` columns. Archiving a teamspace tombstones it and all its pages with one shared timestamp, exactly like a subtree.
**Deleting a subtree**
- Check `assert("full", { id })` on the root under `$as(actor)`.
- In one transaction, stamp the same `deletedAt` on the root and every descendant (a recursive query over `parent_id`), and set `trash_root` on the root. viborm's own `delete` gives each call its own timestamp, so this step writes the marker directly after the permission check.
- Append one `trash` change row. The live loop removes the pages from every view, the tree and search results.
- The Page DOs close their sockets, so open tabs show "This page was moved to Trash".
**What readers see**
- Reads default to live rows: the sidebar, views, search, AI answers and backlinks all skip tombstones.
- A to-one relation to a tombstone reads `null`, so relation cells show "Deleted page".
- EAV rows, grants and the CRDT stay untouched, so a restore is lossless.
**Trash and restore**
- Trash lists `page.findMany({ deleted: "only", where: { trash_root: true } })`, searchable and sortable by deletion date.
- Restore clears the marker on every row sharing the root's `deletedAt` inside its subtree. If the parent is still in Trash, the page is restored to the workspace root.
- Undo after a delete is a restore of that timestamp.
**Purge after 30 days** (a daily alarm starts the `PURGE` Workflow):
- `purgeMany` the pages whose `deletedAt` is older than the cutoff; EAV rows, grants, links and collection members go with them.
- Wipe each Page DO with `ctx.storage.deleteAll()` and delete its R2 snapshots and history.
- Delete files referenced only by purged pages, their Vectorize chunks and their search rows.
**Inside a page,** deleted blocks are not rows: edytor keeps them in its history and purges deleted content after `purgeAfterDays` (set it to 30).
**Workspace deletion** soft-deletes the D1 row and blocks sign-in to it, waits 30 days, then a Workflow deletes the Workspace DO, every Page DO, its R2 prefix and its vectors.
**Unique keys** that must ignore tombstones, such as share tokens, use partial unique indexes with `WHERE "deletedAt" IS NULL`.

## API
One oRPC contract serves the app's private RPC at `/rpc` and a public REST API at `/v1`. Both are thin: they authenticate, build an actor and forward to the Workspace or Page Durable Object, where every rule is enforced.
**Contract first**
```ts
// src/server/rpc/contract.ts — schemas are Standard Schema (viborm validation or Valibot)
export const contract = {
  page: {
    create: oc.input(PageCreate).output(PageRef),
    move:   oc.input(PageMove).output(Seq),
    trash:  oc.input(PageId).output(Seq),
  },
  db: {
    query: oc.route({ method: "POST", path: "/databases/{id}/query" })
             .input(DatabaseQuery).output(QueryPage),
  },
  mutate: oc.input(MutationBatch).output(Seq),
};
```

**Private API (****`/rpc`****, session cookie)**
- Middleware: session, actor, workspace membership (from D1, cached in the Workspace DO), rate limit.
- Routers: `workspace` (create, settings, members, invites, teamspaces and their members), `page` (create, move, duplicate, trash, restore, history), `property`, `collection`, `view`, `mutate` (batched value and structure ops), `search`, `ai`, `files`, `tokens`.
- AI answers stream back as oRPC event iterators.
- The Svelte client uses `createORPCClient` with an `RPCLink` typed from the contract. The same contract can run over the workspace socket later without changing call sites.
**Public API (****`/v1`****, bearer token)**
- `OpenAPIHandler` with the spec generated by oRPC, and a Scalar reference page at `/v1/docs`.
- Tokens are hashed in D1 with scopes. A request binds `db.$as(actor, scopes)`, for example `["page.read", "page.update"]`; an empty scope list grants nothing.
- Endpoints follow Notion's API shape:
- pages: create, read, update properties, trash and restore
- blocks: list children (the room's `read()`) and append (the room's `transact`)
- databases: query with the same filter AST as the UI
- search, comments, users
- Cursor pagination, `Idempotency-Key` on writes (kept 24 hours in the Workspace DO), and per-token limits through `RL_API`.
- Versioned under `/v1`; breaking changes go to `/v2` with both live for a deprecation period.

## AI features
Basic AI runs on Workers AI behind AI Gateway, in three features: writing actions inside the editor, questions answered from the workspace, and database properties the model fills in.
| Feature | Where | How it works | 
| Write with AI: continue, summarize, improve, fix spelling, translate, change tone, explain | `/ai` in the slash menu, the selection toolbar | Tokens stream through an oRPC event iterator and land as a shared suggestion, so collaborators see the draft and a writer accepts or rejects it | 
| Ask the workspace | A side panel on `⌘J` built from entasis AI chat, composer, message and thread | Embed the question, query Vectorize filtered by workspace, drop chunks outside the visibility set, answer with links to the source pages | 
| AI properties: summary, keywords, translation, custom prompt | A database property type | A queue job after the page is saved, debounced by 30 seconds, writes a computed `p_text` value | **Indexing pipeline**
- The Page DO's `onSave` enqueues `{ workspaceId, pageId, version }` on `JOBS`.
- The consumer reads the page's JSON, splits it at headings into chunks of about 500 tokens and skips chunks whose hash has not changed.
- It embeds new chunks with a Workers AI embedding model and upserts them to Vectorize as `pageId:chunk`, with `workspaceId` and `pageId` as metadata.
- It deletes chunks that no longer exist.
**Guardrails**
- Prompts include only text the actor may read; retrieval filters by the visibility set before ranking.
- Page content goes into prompts as quoted data, never as instructions.
- No usage caps: the app is for internal use. AI Gateway still adds caching and request logs.
- Workers AI models only, with no external providers. Model ids live in config; re-embed if the embedding model changes.

## Search
Quick find and full-text search run on SQLite FTS5 inside the Workspace Durable Object; semantic search adds Vectorize. Every result is intersected with the actor's visibility set before it is ranked and cut to a page of results.
- **Index:** one FTS5 table, `search(page_num, field, text)`, with the porter and unicode tokenizers. Fields are the title (boosted), text property values and body chunks. Cloudflare's own Agents SDK runs FTS5 on Durable Object SQLite, so the extension is available there.
- **Freshness:** titles and properties are indexed in the write transaction. Body text arrives from the Page DO's `onSave`, through the batched indexing queue, typically within 30 seconds of the last edit.
- **Quick find (****`⌘K`****):** entasis Command with title prefix matches first, then recently visited pages from a per-user `visit` table, then full-text hits.
- **Search page:** snippets from FTS5's `snippet()`, filters for creator, last edited and location in the tree, sort by relevance or date.
- **Semantic results:** when the query reads like a question, Vectorize hits are merged with full-text hits by reciprocal rank fusion.
- **Permissions:** fetch three times the requested count, keep only visible pages, then rank, so hidden pages never leak through counts or snippets.

## Files and media
Files go to R2 through the Worker, keyed by workspace and page, and are served only after a permission check on the page that owns them.
- **Begin:** the client calls `files.begin({ pageId, name, size, type })`. The Worker checks `can("update")` on the page and the workspace's storage quota, then returns a `fileId`.
- **Upload:** the client streams the body to `PUT /files/:fileId`. Large files use R2 multipart uploads through `/files/:fileId/parts` endpoints, so no single request carries the whole file.
- **Commit:** the Worker records the file in the Workspace DO, under `ws/{workspaceId}/{fileId}`.
- **Download:** `GET /files/:fileId` finds the owning page, checks `can("read")`, and streams from R2 with `Cache-Control: private` and range support for video.
- **Images:** covers, gallery cards and inline images get resized variants through Cloudflare Images transformations.
- edytor's image, file, video and audio plugins call this flow from their `upload` option. Bookmark unfurls are fetched by the Worker, parsed with HTMLRewriter and cached in KV.
- Published pages use signed URLs that expire after a few minutes.
- Purge deletes files referenced only by purged pages, and a weekly sweep removes uploads that were never committed.

## Frontend
The signed-in app is a client-rendered SvelteKit area (`ssr = false` in the `(app)` layout) that talks to the Worker through the oRPC client, the workspace socket and edytor rooms. Only published pages render on the server.
Client rendering avoids the dev-mode deadlock and costs little, because every screen is behind sign-in and filled from live subscriptions anyway.
| Route | Purpose | Main entasis components | 
| `/login`, `/signup`, `/invite/[token]` | Passkey flows | Card, Form, Text input, Button, Alert | 
| `/[ws]` | Home: recent and favorite pages | App shell, Sidebar, Tree | 
| `/[ws]/[page]` | A page or a full-page database | Page shell, Breadcrumbs, Tabs, the editor, the view components | 
| `/[ws]/trash` | Trash with restore and delete forever | Data table, Confirmation | 
| `/[ws]/settings/*` | Members, teamspaces, passkeys, API tokens | Data table, Dialog, Toast | 
| `/share/[token]` | Published page, read-only | Server HTML from the room's `read()` and `edytor/export`, cached in KV | **Client state**
- `workspace.svelte.ts` is a runes store with normalized pages, properties, views and subscription windows. It applies diffs in `seq` order and keeps an optimistic layer per mutation id.
- `socket.ts` reconnects with backoff, resends subscriptions and its last `seq`, and drives entasis Network indicator.
- IndexedDB keeps the last tree and recent view windows for an instant start; edytor keeps page bodies offline itself.
**Component map**
- Navigation: Sidebar with Teamspaces, Shared and Private sections, Tree (drag to reorder and nest), Command for `⌘K`, Breadcrumbs, Tabs for views.
- Property editors: Select, Combobox, Tags input, Date input with Calendar, Number input, Checkbox, Avatar group for people.
- Menus and overlays: Menu, Context menu, Popover, Dialog, Hover card and Link preview for page mentions, Tooltip, Toast.
- Content: Image gallery and zoom, Video and Audio player, Document viewer, Code, Mermaid, Diff for history.
- AI: Chat, Composer, Message, Thread and Suggestion.
**To build:** an icon and emoji picker, the cover repositioning header, a nested filter builder, property cell renderers, and checks that Data table virtualizes thousands of rows with inline editing.
**Shortcuts:** edytor supplies Notion's editing keys; the app adds `⌘K` search, `⌘\` sidebar, `⌘J` AI and `⌘⇧L` dark mode. The layout is responsive, with the sidebar as an overlay on phones.

## Design system: Notion's look on entasis
One token file, `src/lib/design/notion.tokens.ts`, drives three consumers: entasis's theme engine for the app chrome, edytor's Notion theme for documents, and the app's own CSS for Notion-only surfaces. The values below are starting points from three references that differ by a few hex points; the final values come from measuring the live app.
**Who styles what**
| Layer | Styled by | Notes | 
| App chrome: sidebar, menus, dialogs, inputs, buttons, tables, tooltips | entasis theme blocks, `<Theme designTokens>` and each component's `theme` override | Never through entasis's private component variables | 
| Documents: blocks, marks, mentions, page links | `edytor/themes/notion.css` with its `--notion-*` and block color tokens overridden | The theme is light-only, so dark mode redefines its tokens | 
| Notion-only surfaces: page header, cover, property rows, view tabs, board cards | App components on the same CSS variables | Built with entasis primitives where they fit | **Core tokens** (seed values)
| Token | Light | Dark | Used for | 
| Page | `#ffffff` | `#191919` | Page and menu background | 
| Sidebar | `#f9f8f7` | `#202020` | Sidebar and settings navigation | 
| Text | `#2c2c2b` | `rgba(255,255,255,0.81)` | Body text, never pure black | 
| Secondary text | `#73726e` | `rgba(255,255,255,0.46)` | Captions, table headers, done to-dos | 
| Tertiary text | `#91918e` | `rgba(255,255,255,0.32)` | Placeholders, section labels | 
| Sidebar text | `#5f5e5b` | `rgba(255,255,255,0.62)` | Tree rows, breadcrumbs, top bar buttons | 
| Hairline | `rgba(28,19,1,0.11)` | `rgba(255,255,255,0.094)` | Dividers, table grid, input borders | 
| Hover wash | `rgba(55,53,47,0.06)` | `rgba(255,255,255,0.055)` | Every hoverable row and button | 
| Active row | `rgba(55,53,47,0.08)` | `rgba(255,255,255,0.08)` | Current page, selected option | 
| Accent | `#2383e2` | `#2383e2` | Primary buttons, links, checked to-dos, focus | 
| Text selection | `rgba(35,131,226,0.28)` | measure | Selected text; selected blocks use 0.14 | 
| Danger | `#cd3c3a` | `#df5452` | Destructive actions | 
| Callout panel | `#f9f8f7` | `#252525` | Callouts | 
| Code panel | `#f7f6f3` | `#202020` | Code blocks | 
| Menu shadow | `rgba(15,15,15,0.05) 0 0 0 1px, rgba(15,15,15,0.1) 0 3px 6px, rgba(15,15,15,0.2) 0 9px 24px` | the same layers at 0.2, 0.4 and 0.6 | Every floating surface | **Block colors** (text and background, as Notion's color menu applies them)
| Name | Text, light | Background, light | Text, dark | Background, dark | 
| Gray | `#787774` | `#F1F1EF` | `#9B9B9B` | `#252525` | 
| Brown | `#976D57` | `#F3EEEE` | `#A27763` | `#2E2724` | 
| Orange | `#CC782F` | `#F8ECDF` | `#CB7B37` | `#36291F` | 
| Yellow | `#C29343` | `#FAF3DD` | `#C19138` | `#372E20` | 
| Green | `#548164` | `#EEF3ED` | `#4F9768` | `#242B26` | 
| Blue | `#487CA5` | `#E9F3F7` | `#447ACB` | `#1F282D` | 
| Purple | `#8A67AB` | `#F6F3F8` | `#865DBB` | `#2A2430` | 
| Pink | `#B35488` | `#F9F2F5` | `#BA4A78` | `#2E2328` | 
| Red | `#C4554D` | `#FAECEC` | `#BE524B` | `#332523` | Select and status options use a separate, stronger palette (light gray `#e3e2e0`, light red `#ffe2dd`, with near-black text). edytor's built-in block colors differ slightly (red text `#cf5148` on `#fce9e7`), so set its `--edytor-color-*` and `--edytor-background-*` tokens from this table.
**Type and metrics**
- **Fonts:** the system sans stack Notion's app uses (`ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial`, then emoji fonts) and `SFMono-Regular, Menlo` for code. The per-page Serif and Mono styles use a Georgia-based and a monospace stack, not Notion's licensed fonts.
- **Sizes:** chrome at 14px with 12px small text; documents at 16px with a 1.5 line height; headings at 1.875, 1.5 and 1.25 em, weight 600; page title 40px, weight 700. edytor's theme already sets the document sizes.
- **Metrics:** sidebar 240 to 260px and resizable, top bar 44px, sidebar and menu rows 28px, table rows 36px, property rows 34px, buttons 28px (small 24px), inputs 32px, option tags 20px with 3px corners, 24px nesting step, covers about 30vh.
- **Radius:** controls 6px, panels and menus about 10px, tags 3px. The page column is about 708 to 760px wide (measure), with Notion's per-page Full width and Small text options.
**entasis configuration** (build-time blocks in `app.css`)
```css
@import 'tailwindcss';
@source '../node_modules/entasis/dist';

@plugin 'entasis/tailwind-plugin/theme' {
  name: light; default: true; colorscheme: light;
  surface: #ffffff; neutral: #2c2c2b; secondary: #f1f1ef;
  primary: #2383e2; info: #2383e2; danger: #cd3c3a; success: #448361; warning: #cb912f;
  state-hover-opacity: 0.06; state-pressed-opacity: 0.09; state-selected-opacity: 0.08;
  radius: 0.75;   /* md 6px for controls, sm 3px for tags */
}

@plugin 'entasis/tailwind-plugin/theme' {
  name: dark; colorscheme: dark; prefersDark: true;
  surface: #191919; neutral: #d4d4d4;
  primary: #2383e2; danger: #df5452; success: #529e72; warning: #ca8f3d;
  state-hover-opacity: 0.055; state-pressed-opacity: 0.08; state-selected-opacity: 0.08;
}

@theme {
  --font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica,
               "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol";
  --font-mono: "SFMono-Regular", Menlo, Consolas, monospace;
}
```

The dark hover opacity matters most: entasis's dark default is 0.16, almost three times Notion's wash.
**Runtime tokens** in the root layout: `<Theme designTokens={{ light: notion, dark: notion }}>` with `typeScale` set to a 16px base at every viewport width (no fluid growth), `raisedWithBorder: false` (Notion rings floating surfaces with a shadow layer, not a border), `defaultColor: 'neutral'`, `selectedColor: 'neutral'`, `focusColor: 'primary'`, and motion durations of about 100 and 150 ms.
**What the theme engine can't express**
- **Non-monotonic surfaces.** The sidebar is darker than the page in light mode but lighter in dark mode, so no single step of entasis's surface ladder fits both. Define `--app-sidebar` per theme and pass it through the Sidebar's `theme` override.
- **Exact shadows.** Set `--elevation-3` to Notion's three-layer menu shadow per theme, with a selector at least as specific as `html[data-theme]`, where `designTokens` writes.
- **Row heights.** entasis rows are 32, 40 and 48px; Notion's are 28 and 36px. Use each component's density variant or `theme` override.
**Steps**
- **Measure:** in a reference Notion workspace, in light and dark mode, read computed colors, sizes and shadows for about 30 elements with DevTools. Record them in the token file with the date measured.
- **Generate:** a build script writes the entasis theme blocks, the edytor overrides and the app variables from the token file, so one edit updates all three.
- **Configure** `<Theme designTokens>` and the edytor `edytor-notion` class in the root layout.
- **Component pass:** for every entasis component the app uses, compare a 100% zoom screenshot with Notion's equivalent and fix it through props, density variants or its `theme` override.
- **Upstream gaps:** you own entasis, so add a `notion` preset (theme blocks plus `designTokens`) and the missing row-height and shadow hooks there, rather than patching around them in the app.
- **Verify:** Playwright visual baselines for 20 key screens in both themes, and a metrics test asserting computed row heights, font sizes and radii equal the token file. Notion's secondary text sits slightly below WCAG AA contrast; keep it by default and offer a high-contrast setting.
Use your own product name, logo and icon set: match Notion's layout, palette and rhythm, not its logo, wordmark, illustrations or licensed fonts.

## Security and reliability
A critical review of this plan found six design gaps. Fixes for the first two are already folded into the sections above; all six are listed here with the security rules and operating targets that go with them.
**Design fixes from the review**
| Gap | Why it hurts | Fix | 
| Index fan-in | Every Page DO saving every 2 s would funnel hundreds of writes per second into one Workspace DO during busy hours | Page DOs enqueue a deduplicated job; the consumer batches up to 100 pages per call, at most once per page every 30 s | 
| Visibility rebuilds | Rebuilding every connected actor's set on each grant change costs actors × pages | Recompute lazily, only for affected actors and subtrees; full rebuild as the fallback | 
| Two copies of membership | D1 membership and the Workspace DO mirror can drift | One procedure writes D1, then the DO through an outbox with retries; a nightly job reconciles both | 
| Share links in two stores | The D1 route and the DO grant can disagree | Create the DO grant before the D1 route, revoke in reverse order, reconcile nightly | 
| Change log growth | Live title typing writes a row per debounce | Coalesce edits by one actor to one property within 5 s; cap retention at 7 days and a size limit | 
| Version skew | Old clients send old ops or block kinds | Every socket and call carries the app version; outdated sockets close with a "reload" code, and `kinds.ts` carries a version the rooms check | **Security rules**
- **CSRF:** cookie-authenticated `/rpc` accepts only `POST` with JSON, checks `Origin`, and uses oRPC's CSRF protection; session cookies are `SameSite=Lax`, `Secure`, `HttpOnly`.
- **Socket origins:** `allowedOrigins` on the workspace socket and every edytor route, since browsers send cookies with any WebSocket dial.
- **Room names:** Page DOs are named `workspaceId:pageId`, so a room can never be reached from another workspace.
- **User files:** served from a separate files subdomain without cookies, with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` for anything that is not an image, video or audio.
- **CSP:** a per-request nonce passed to entasis's `<Theme nonce>`; published pages render sanitized HTML from `edytor/export`.
- **Secrets:** the better-auth secret, room-token key and API-token pepper are Worker secrets, rotated with a two-key overlap.
- **API tokens:** hashed with the pepper, shown once, scoped, revocable, and logged per use.
- **Account deletion:** removes memberships and passkeys, and shows the user as "Deleted user" in history and attribution.
- **Abuse limits:** rate limits on sign-in, invites and published pages; published pages are `noindex` by default.
**Operating targets** (proposed, to confirm after the first load test)
| Signal | Target | Alert when | 
| `/rpc` availability | 99.9% per month | Error rate above 1% for 5 minutes | 
| Edit to collaborator diff, same region, p95 | 150 ms | Above 300 ms for 10 minutes | 
| Workspace socket reconnects | Below 1% of sockets per hour | Five times the weekly baseline | 
| Indexing queue lag | Under 60 s | Over 5 minutes | 
| Workspace DO storage | Under 5 GB | Over 5 GB | 
| Page document size | Under 80% of quota | Over 80%, also shown to the user | **Runbooks**
- **Workspace DO overloaded:** stop re-evaluating subscriptions of hidden tabs, widen batching, and alert; never drop writes.
- **D1 unavailable:** existing sessions keep working from the cookie cache; sign-in, invites and token creation show a retry message.
- **Workers AI or Vectorize down:** AI features show a banner and turn off; nothing else depends on them.
- **Restore a workspace:** point-in-time recovery of its Workspace DO, then replay indexing for its pages.
- **Bad Durable Object migration:** migrations are additive and behind a flag; roll back by deploying the previous version, which still reads the new columns.

## Performance, limits and scaling
One workspace fits in one Durable Object for nearly every team. What to watch is CPU spent on fan-out in that single thread, the 100-parameter statement budget, edytor's document quota and the object's single location.
| Limit | Value | Plan | 
| SQLite per Durable Object | 10 GB | Bodies live in Page DOs, so the Workspace DO holds metadata, properties and search only. Alert at 5 GB; shard by type beyond that. | 
| Memory per object | 128 MB | Budget about half for subscriptions, visibility sets, bitmaps and row caches. | 
| Throughput | One thread, soft limit near 1,000 requests per second | Batch mutations, share identical subscriptions, re-check only views that reference the written property. | 
| Hibernatable WebSockets | 32,768 per object | One socket per tab is far below this. | 
| Bound parameters | 100 per statement | Chunk `IN` lists and keep policy constants in rows. | 
| CPU per invocation | 30 s by default, up to 5 minutes | Imports, renames across thousands of pages and rebuilds run as Workflows or alarm batches. | 
| edytor document | 2 MiB by default | Raise to 16 MiB; warn at 80%. | **Targets to validate in load tests** (my estimates, not measurements): a property edit reaches collaborators in the same region within 150 ms at p95, a view's first window renders within 300 ms from a cold object, and one workspace serves 1,000 concurrent tabs.
**When to optimize**
- Start with SQLite range scans over the clustered EAV tables. Add Roaring bitmaps, compiled to WebAssembly, for select, status, person and tag properties when profiling shows filters or fan-out dominating.
- Create each Workspace DO with a location hint near the team that created it. Optimistic UI hides most of the distance for everyone else.
- A workspace that outgrows one object shards its property index by type or tag, so most queries stay on one shard.

## Testing, observability and operations
The query engine and the permission policy carry the most risk, so both are tested against simple reference models on random data, not only with hand-written cases.
**Tests**
- **Unit:** filter AST, formula parser and evaluator, property codecs and sort keys, with Vitest.
- **Durable Objects:** both classes run in workerd through `@cloudflare/vitest-pool-workers`, against real SQLite.
- **Query engine oracle:** generate random workspaces and filters, then compare engine results with a naive in-memory evaluation.
- **Live-update fuzz:** apply random writes and assert every subscription window equals a fresh run of its query, with faults injected between steps.
- **Permission matrix:** generate trees, teamspaces and grants, and check `can()` and the visibility sets against a reference model for owners, members, guests and anonymous visitors.
- **Editor:** multi-client convergence with headless edytor documents, plus `validate` and lock rules.
- **End to end:** Playwright with Chrome's virtual WebAuthn authenticator for passkeys, and two browsers editing one page and one database.
- **Load:** scripted sockets and writes against staging, recording fan-out latency at p50 and p99.
**Observability**
- Workers Logs and a Tail Worker for errors; Analytics Engine for mutation latency, fan-out size, subscriptions per object and storage bytes.
- viborm's instrumentation extension for OpenTelemetry traces; edytor's room metrics and log for refusals and quotas.
**Operations**
- **Backups:** Durable Object SQLite point-in-time recovery, plus a nightly logical export of each Workspace DO to R2. D1 has Time Travel.
- **Migrations:** D1 through `wrangler d1 migrations apply` with SQL generated by viborm. Durable Object schemas are versioned and migrated inside `blockConcurrencyWhile` when an object wakes.
- **Deploys:** GitHub Actions runs type checks and tests, then `wrangler deploy` with gradual deployments. Feature flags live in D1, cached in KV.

## Implementation phases
Five tracks run in parallel through five phases. One developer or a pair can own each track, and a phase ends when its gate passes, not on a date.
[Diagram: implementation plan · five parallel tracks across five phases]

Everything in the same row runs at the same time. The highlighted Sync core track is the critical path: a slip there moves the finish, while a slip elsewhere usually does not.
**What keeps the tracks unblocked**
- **Contracts first.** The oRPC contract, socket messages, filter AST and block kinds live in `lib/shared` from P0, so every track builds and tests against them with mocks.
- **Stand-ins until the real thing lands.** The query engine takes the visibility set as an input and uses "every page" until permissions ship. View screens start on static snapshots and switch to live windows when the engine is ready. The app runs against a mocked socket until the protocol exists.
- **Smaller team:** merge Databases into Sync core and Accounts into App UI. The order inside each track stays the same.

### P0 · Foundations and spikes
- **Sync core:** viborm driver over `ctx.storage.sql` (CRUD, `transactionSync`, migrations); measure the policy's largest reads against the 100-parameter limit.
- **Databases:** filter AST, property codecs and sort keys; the oRPC contract and socket message types.
- **Editor and files:** edytor's `attachRoom` in a Page DO behind `routeDocumentSocket` with a signed room token; an FTS5 smoke test in a Durable Object.
- **App UI and design:** measure Notion, write the token file, generate the entasis and edytor themes, build a static app shell.
- **Accounts, AI, API:** repository, Wrangler environments, bindings, CI and preview deploys; pick oRPC v1 or v2 and prove its hibernation socket.
- **Gate:** the driver passes viborm's tests on Durable Object SQLite, and a socket survives hibernation.

### P1 · Building blocks
- **Sync core:** Workspace DO schema and migrations, the mutation path with its change log and `seq`, socket protocol, subscription registry, reconnect replay.
- **Databases:** typed EAV tables, property registry, typed writes with `props_json`, per-value counts.
- **Editor and files:** Page DO with every bundled plugin, page header, subpages, snapshots to R2, indexing jobs.
- **App UI and design:** routes, runes store, socket client, sidebar shell, page view with the editor, command palette shell.
- **Accounts, AI, API:** passkey sign-up and sign-in, the viborm adapter for better-auth, D1 schema, workspaces, invites by email.
- **Gate:** two users sign in with passkeys, share a workspace and co-edit a page.

### P2 · Access, engine, content
- **Sync core:** viborm policy with teamspaces, grants and inheritance; visibility sets; room access sync.
- **Databases:** query compiler ordered by selectivity, oracle tests, formula parser.
- **Editor and files:** custom blocks (database view, breadcrumb, date mention), files on R2, comments, page locks.
- **App UI and design:** live sidebar tree with drag and drop, teamspace screens, share dialog, properties panel.
- **Accounts, AI, API:** guests, public share links, invite and mention emails.
- **Gate:** the permission matrix passes for every role and share type, and the engine matches the oracle.

### P3 · Live databases, history, search
- **Sync core:** live queries (enter, leave, move, update, refill), view windows, subtree soft delete, trash and purge.
- **Databases:** relations, rollups and the dependency graph; grouping for boards.
- **Editor and files:** version history in R2 with the history panel; AI writing as shared suggestions.
- **App UI and design:** table, board, list, gallery, calendar and timeline views; filter builder; trash screen.
- **Accounts, AI, API:** the batched indexing consumer into FTS5; Vectorize chunks and embeddings.
- **Gate:** the live-update fuzz passes, restore is lossless, and diffs reach collaborators within target.

### P4 · AI, public API, scale
- **Sync core:** bitmaps where profiling asks for them, load tests, backups and a restore drill.
- **Databases:** CSV import and AI properties.
- **Editor and files:** Markdown and HTML export, published pages.
- **App UI and design:** quick find, the Ask AI panel, accessibility and mobile web, the visual regression suite.
- **Accounts, AI, API:** Ask AI backend, the OpenAPI public API with tokens and rate limits, SLO dashboards and alerts.
- **Gate:** the load test meets the targets, no search result or AI answer cites a hidden page, and the API reference is published.

## Risks and open questions
The two largest risks are building viborm's Durable Object driver with policies that fit SQLite's statement limits, and live-query fan-out on popular properties. Both are tested in the first phases, before features depend on them.
| Risk | Why it matters | Mitigation | 
| viborm on Durable Object SQLite | Every data path depends on it | Build the driver in P0; run the permission policy's largest reads against the 100-parameter and 100 KB statement limits | 
| Fan-out on hot properties | A `status` write re-checks every view filtered on status, in one thread | Shared subscriptions, batching, bitmaps; synthetic load test in P3, the full one in P4 | 
| Recursive permission walks | Every row walks its ancestors | Cached visibility sets; a closure table if profiling demands it | 
| Access changes on big subtrees | One grant can touch thousands of open rooms | Only pages in `open_room` are notified, in batches; worst case, close and re-authorize | 
| Experimental transports | oRPC's hibernation support is new and v2 is in beta | Keep the socket protocol thin; a plain JSON protocol is the fallback | 
| Email Sending in beta | Invites and recovery depend on it | Send through one mail interface that another transport can replace | 
| One location per workspace | Distant users pay a round trip on writes | Location hint at creation; optimistic UI | **Decisions** (settled 7 November 2026)
| Question | Decision | 
| Where the title lives | Workspace property, last-writer-wins | 
| Teamspaces | First-class model with members, privacy and a default access level | 
| Offline edits | Properties and structure are read-only offline; page bodies stay editable | 
| Page access levels | Four, as in Notion; no "Can suggest" | 
| Trash retention | 30 days for every workspace | 
| AI usage limits | None, because the app is for internal use | 
| AI models | Workers AI only | 

## Sources
- [edytor home](https://edytor.dev/), [plugins](https://edytor.dev/docs/plugins), [blocks](https://edytor.dev/docs/customization/blocks), [your own Durable Object](https://edytor.dev/docs/server/extending), [authorization](https://edytor.dev/docs/server/authorization)
- [viborm home](https://viborm.dev/), [drivers](https://viborm.dev/docs/drivers), [extensions](https://viborm.dev/docs/extensions), [permissions](https://viborm.dev/docs/extensions/permissions), [soft delete](https://viborm.dev/docs/extensions/soft-delete)
- [entasis](https://entasis.beynar.workers.dev/)
- [sveltekit-cloudflare-worker](https://github.com/beynar/sveltekit-cloudflare-worker)
- [better-auth passkey plugin](https://better-auth.com/docs/beta/plugins/passkey)
- [oRPC hibernation integration](https://orpc.dev/docs/integrations/hibernation)
- [Durable Objects limits](https://04f8f8ae.preview.developers.cloudflare.com/durable-objects/platform/limits) and [WebSocket Hibernation API](https://developers.cloudflare.com:2053/durable-objects/api/websockets); SQLite storage is 10 GB per object since its general availability
- [Agents SDK sessions (FTS5 on Durable Object SQLite, 128 MB Workers memory)](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)
- [Cloudflare Email Service guide](https://flaviocopes.com/cloudflare-email-service/)
- [entasis theme and setup](https://entasis.beynar.workers.dev/docs), [color system](https://entasis.beynar.workers.dev/docs/colors), [tokens](https://entasis.beynar.workers.dev/docs/tokens)
- [edytor styling and Notion theme](https://edytor.dev/docs/customization/styling)
- [NotionKit design tokens (light and dark chrome values)](https://cdn.jsdelivr.net/npm/@jungherz-de/notionkit@1.19.1/SKILL.md)
- [Notion colors, all hex codes (updated July 2026)](https://matthiasfrank.de/en/notion-colors/)