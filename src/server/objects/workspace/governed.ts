/**
 * Governed single-row writes. Under `db.$as(actor)` a single-row `update` or `delete` that the policy does not let
 * through does not do nothing: it throws `NotFoundError` (V6001), the same for a row that is hidden, missing or
 * readable but not allowed (`tests/workers/db/governed-writes.test.ts`). Only `updateMany` / `deleteMany` answer
 * `{ count: 0 }`.
 *
 * So the write is its own check: no access read before it. Only when it fails do we read `$access.read` (the one
 * extra statement, on the failure path) to tell "does not exist for you" (404) from "you may look, not touch" (403),
 * which is what the policy deliberately does not say.
 */
import { isNotFoundError } from 'viborm';
import type { WorkspaceError } from './errors';

/**
 * Runs `write`, a governed single-row `update` or `delete`. When the policy refuses it (`NotFoundError`),
 * throws the error `explain` builds; any other error passes through unchanged.
 */
export async function orExplain<T>(write: () => Promise<T>, explain: () => Promise<WorkspaceError>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
		throw await explain();
	}
}

/** The read surface of a governed model that `$access` needs (viborm types it per schema; we only need the booleans). */
interface AccessDelegate {
	findFirst(args: { where: unknown; select: { $access: readonly string[] } }): Promise<{ $access: Record<string, boolean> } | null>;
}

/**
 * What the actor may do with the first row `where` matches, one boolean per asked action: `$access` (viborm 1.14.0
 * removed `can`). A row the actor cannot see answers `false` for every action.
 */
export async function accessTo<A extends string>(delegate: unknown, where: unknown, actions: readonly A[]): Promise<Record<A, boolean>> {
	const row = await (delegate as AccessDelegate).findFirst({ where, select: { $access: actions } });
	const out = {} as Record<A, boolean>;
	for (const action of actions) out[action] = row?.$access[action] === true;
	return out;
}

/** Whether the actor holds `action` on the first row `where` matches. */
export const can = async (delegate: unknown, action: string, where: unknown): Promise<boolean> =>
	(await accessTo(delegate, where, [action]))[action] === true;

/** Whether the actor can read the row. */
export const canRead = (delegate: unknown, where: unknown): Promise<boolean> => can(delegate, 'read', where);
