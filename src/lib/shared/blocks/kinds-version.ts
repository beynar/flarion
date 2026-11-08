/**
 * The block kinds' version and its check, apart from `kinds.ts` so that a caller that only compares versions (the Workspace DO's
 * `hello` handshake) does not evaluate edytor's CRDT, which `kinds.ts` imports for its semantics. `kinds.ts` re-exports both.
 *
 * KINDS_VERSION is bumped whenever a kind is added or its roles, data shape or semantics change (see `kinds.ts`).
 * The client sends it in `hello` (and in edytor room params); a room refuses a client that is behind.
 */
export const KINDS_VERSION = 2;

/**
 * `ok` when the versions match; `reload` when the client is behind (it may send blocks the room
 * would misread: close it with the protocol's reload code); `ahead` when the client is newer than
 * the room (a deploy is rolling out: the room may keep serving it, unknown kinds degrade to
 * plain blocks).
 */
export function checkKindsVersion(
	client: number | null | undefined,
	room: number = KINDS_VERSION
): 'ok' | 'reload' | 'ahead' {
	if (typeof client !== 'number' || !Number.isInteger(client)) return 'reload';
	if (client === room) return 'ok';
	return client < room ? 'reload' : 'ahead';
}
