/**
 * Governed single-row writes. Under `db.$as(actor)` a single-row `update` or `delete` that the policy does not let
 * through does not do nothing: it throws `NotFoundError` (V6001), the same for a row that is hidden, missing or
 * readable but not allowed (viborm 1.12.1; `tests/workers/db/governed-writes.test.ts`). Only `updateMany` /
 * `deleteMany` answer `{ count: 0 }`.
 *
 * So the write is its own check: no `can` before it. Only when it fails do we ask `can('read')` (the one extra
 * statement, on the failure path) to tell "does not exist for you" (404) from "you may look, not touch" (403), which
 * is what the policy deliberately does not say.
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

/** The delegate surface `can` of a governed model. */
export interface CanDelegate {
	can(action: string, where: unknown): Promise<boolean>;
}

/** Whether the actor can read the row (a `can('read')` on a governed delegate). */
export const canRead = (delegate: unknown, where: unknown): Promise<boolean> => (delegate as CanDelegate).can('read', where);
