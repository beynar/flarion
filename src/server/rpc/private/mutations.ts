/** Shared plumbing of the Sync core's handlers: batches built from a handler call. */
import { APP_VERSION_HEADER } from '../../../lib/shared/protocol';
import type { Op } from '../../../lib/shared/ops';
import type { WorkspaceContext } from './base';

/** The client build of this call: the `x-app-version` header, else the server's own (API and tests). */
export const appVersionOf = (context: Pick<WorkspaceContext, 'request' | 'env'>): string =>
	context.request.headers.get(APP_VERSION_HEADER) ?? String(context.env.APP_VERSION);

/** Applies ops as one batch with a fresh mutation id (these are not retries of a client `mid`). */
export function applyOps(context: WorkspaceContext, ops: Op[]): Promise<{ seq: number }> {
	return context.workspace.apply(context.actor, {
		mid: `rpc-${crypto.randomUUID()}`,
		ops,
		appVersion: appVersionOf(context)
	});
}
