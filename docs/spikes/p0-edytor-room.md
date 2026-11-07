# P0 spike: edytor room in a Page DO behind a signed token

Code: `src/server/objects/page/`, `src/server/rooms/`, `src/server/http/room-route.ts`. Tests: `tests/workers/rooms/`.

## edytor 7.0.4 APIs used
- `edytor/cloudflare`: `attachRoom(this, options)` (in the DO constructor; returns `AttachedDocument`), `routeDocumentSocket(request, namespace, documentId, authorize, { allowedOrigins })`, `closedSocket`, `requestedReplica`, `SOCKET_TAG`, types `AuthorizeDocumentSocket`, `DocumentNamespace`, `DocumentAccessLevel`, `LoadedDocument`, `SavedDocument`, `ReplicaOwner`, `FrameValidation`.
- Tests also use `edytor/protocol` (`WebsocketProvider`) and `edytor/crdt/edytor` (`createDocument`), the shipped headless client path, over a `WebSocket` polyfill that dials through `SELF.fetch`.

## How it fits
- `routeDocumentSocket` calls `rooms.getByName(documentId)` only after `authorize` accepts, so the route verifies the token first, then hands edytor a one-method namespace adapter that names the object `workspaceId:pageId` from the **verified claims**.
- `authorize` outcomes: identity `{ userId, replica, access, expiresAt }`; `{ expired: true }` for a genuine expired token (close **4401**, the provider refreshes `params.token`); `null` for anything else (close **4403**, terminal). `expiresAt = exp * 1000`, so the room itself closes a live socket with 4401 when the token runs out (tested).
- `attachRoom` options in P0: `maxDocumentBytes` 16 MiB, `purgeAfterDays` 30, `onLoad`/`onSave` (R2), `validate`. `semantics`, `history` (`r2History`), `locks`, `comments` options are left at their defaults for P1.
- `onSave` runs on the object's alarm `saveAfter` (2 s) after the first unsaved edit; tests call `runDurableObjectAlarm(stub)`.
- Revocation: `PageDO.setAccess/closeUser` forward edytor's `setAccess`/`closeUser` (`read` downgrades in place, `none` closes 4403, `closeUser(u, 4401)` forces a token refresh) and record the level for `validate`.

## Gotchas found
- The room's replica registry lists the seed writer's client id with `user: ''` (unowned); `replicas.json` therefore holds more entries than signed-in users.
- Durable Object RPC types over edytor's `JSONDoc` make `tsc` fail ("excessively deep"); tests type the stub by hand (`PageStub` in `tests/workers/rooms/helpers.ts`).
- `EdytorDocument` exposes edits directly (`document.insertText(...)`, `document.toJSON()`), not through `.facade`.
- History/comments HTTP doors (`routeDocumentHistory`, `routeDocumentComments`) take their client's `<server>/<room>` URL; they are not routed yet (P1 decides the paths, for example `/rooms/history/:pageId`, and must adjust `ROOM_PATH`).
