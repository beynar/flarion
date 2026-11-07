# P0 spike: oRPC v1 over hibernatable WebSockets

**Decision: oRPC v1 (1.16.2).** The v1 hibernation API is complete enough for the Workspace socket and is
proven in workerd below. v2 (`@orpc/hibernation`, beta) is not needed.

## API used (all from `@orpc/server` v1 and `@orpc/client`)

```ts
import { RPCHandler } from '@orpc/server/websocket';
import { HibernationPlugin, HibernationEventIterator, encodeHibernationRPCEvent } from '@orpc/server/hibernation';
import { RPCLink } from '@orpc/client/websocket';   // client
```

- `new RPCHandler(router, { plugins: [new HibernationPlugin()] })` is the server handler.
- `handler.message(ws, data, { context })` and `handler.close(ws)` are called from the Durable Object's
  `webSocketMessage` and `webSocketClose`. Never use `handler.upgrade(ws)` for hibernatable sockets: it
  registers `addEventListener` handlers that do not survive eviction.
- An event-iterator procedure returns `new HibernationEventIterator<T>((requestId) => ...)`. oRPC sends
  the response head, calls the callback with the request id and does not hold the stream. The owner
  persists the id (a SQL row, not the 2,048-byte attachment) and pushes events with
  `ws.send(encodeHibernationRPCEvent(requestId, payload, { event: 'message' | 'error' | 'done' }))`.
- The `HibernationPlugin` is required: it carries the iterator out of the handler pipeline as the response
  body. Do not combine hibernating iterators with the batch plugin.
- Note: the page https://orpc.dev/docs/integrations/hibernation documents v2 (`@orpc/hibernation`,
  `HibernationHandlerPlugin`, `HibernationAsyncIteratorClass`). The v1 names above are the ones in
  `node_modules/@orpc/server/dist/hibernation`.

## Code

| File | Role |
| --- | --- |
| `src/server/objects/workspace/socket.ts` | Reusable transport: `HibernatableSocketTransport` (`accept`, `message`, `close`, `send`, `sockets`), attachment `{ socketId, actor }` with a 2,048-byte guard, actor header codec |
| `src/server/objects/workspace/subscriptions.ts` | SQL table `socket_subscription (socket_id, request_id, topic)`: subscriptions live in storage |
| `src/server/objects/workspace/demo-router.ts` | `ping` and `subscribe` (P0 only; P1 replaces it with `src/lib/shared/protocol.ts`) |
| `src/server/objects/workspace/workspace-do.ts` | Wiring: `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `publish` |
| `src/server/http/workspace-socket-route.ts` | `/ws/:workspaceId`: upgrade check, `allowedOrigins`, `authenticateUpgrade` seam, forward to `env.WORKSPACE.getByName(id)` |

The Worker puts the actor in the `x-flarion-actor` header of the forwarded request (always overwritten).
The object is only reachable through the Worker, so it trusts that header. `authenticateUpgrade` accepts
`x-flarion-dev-actor: <userId>` only when `ENVIRONMENT` is `test` or `development`; P1 replaces it with a
better-auth session lookup plus a workspace membership check.

## What the tests prove (`tests/workers/socket/`)

`evictDurableObject(stub)` from `@cloudflare/vitest-plugin` tears down the running instance, keeps
storage and, by default, **hibernates** the accepted WebSockets instead of closing them. That is the same
path workerd takes when an idle object is evicted, so true hibernation can be forced in the test pool.

1. `ping` over a real oRPC `RPCLink` on a workerd WebSocket works. The object is evicted. The same socket
   (still `OPEN`) calls `ping` again. A **new instance** answered: `instanceId` (a `crypto.randomUUID()` held
   in memory) differs and the static `WorkspaceDO.constructed` counter rose by exactly one. The attachment
   survived: same `socketId` and `actor`. Repeated eviction works, and two sockets keep distinct identities.
2. An open `subscribe` event iterator keeps receiving events after eviction. `publish()` runs on a fresh
   instance, finds the subscription in SQL and the socket through `ctx.getWebSockets()`, and pushes to the
   iterator the client opened before the eviction (no re-subscribe needed).
3. Cancelling an iterator (`return()`) deletes its row (the `t: 4` abort frame is intercepted by the
   transport); closing the socket deletes all of its rows.
4. A bad `Origin` gets 403, a non-upgrade request or non-GET gets 426, a missing session 401, a malformed
   workspace id 400, a client-supplied actor header is ignored, and an attachment above 2,048 bytes is
   rejected (413 from the object, `AttachmentTooLargeError` in code) at the exact byte boundary. An
   attachment of exactly 2,048 JSON bytes is accepted by workerd.

Sanity check: removing the `evictDurableObject` calls makes tests 1 and 2 fail on the `instanceId` assertion.

## What is not proven or left for P1

- The wall-clock idle eviction itself (about 10 s without activity in production) is not waited for; the
  eviction helper is the substitute. A staging check with a real idle socket belongs in the load test.
- After hibernation, in-flight (non-iterator) requests are not resumed: a handler must finish within one
  wake. Procedures that stream or run long (AI) stay on HTTP `/rpc`.
- oRPC's `ServerPeer` is rebuilt per object wake (a `WeakMap` keyed by the socket). Anything per-socket must
  be derived from the attachment or storage, never from the peer.
- Iterator `abort` frames sent while the object is evicted wake it, so the row is removed. If the socket
  drops without a close frame, `webSocketClose`/`webSocketError` still run and clean up.
- App version skew (close with a "reload" code) and the `seq`-based reconnect replay are protocol work.
