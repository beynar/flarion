/**
 * Maps the errors the Workspace DO throws across DO RPC (`WorkspaceError`, encoded in the message) and
 * the ones Valibot/oRPC already produce into the contract's oRPC errors: `APP_OUTDATED` (426),
 * `VALIDATION_FAILED` (422, with the issues), `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `BAD_REQUEST`.
 */
import { ORPCError } from '@orpc/server';
import { decodeWorkspaceError } from '../../objects/workspace/errors';

/** The error workerd raises when a Durable Object's queue is too long ("Durable Object is overloaded. Requests queued for too long."). */
export const isObjectOverloaded = (error: unknown): boolean =>
	(error as { overloaded?: unknown } | null)?.overloaded === true || (error instanceof Error && /Durable Object is overloaded/i.test(error.message));

export function mapWorkspaceError(error: unknown): unknown {
	if (error instanceof ORPCError) return error;
	// A busy object is not a bug: say so (503), so the client retries the same mutation (its id makes a retry safe) instead of
	// rolling the edit back behind an "Internal server error". Writes are never dropped (docs/PLAN.md runbook).
	if (isObjectOverloaded(error)) return new ORPCError('SERVICE_UNAVAILABLE', { status: 503, message: 'This workspace is busy. Try again in a moment.' });
	const decoded = decodeWorkspaceError(error);
	if (!decoded) return error;
	switch (decoded.code) {
		case 'APP_OUTDATED':
			return new ORPCError('APP_OUTDATED', { status: 426, message: decoded.message });
		case 'VALIDATION_FAILED':
			return new ORPCError('VALIDATION_FAILED', {
				status: 422,
				message: decoded.message,
				data: { issues: decoded.issues }
			});
		case 'NOT_FOUND':
			return new ORPCError('NOT_FOUND', { message: decoded.message });
		case 'FORBIDDEN':
			return new ORPCError('FORBIDDEN', { message: decoded.message });
		case 'CONFLICT':
			return new ORPCError('CONFLICT', { message: decoded.message });
		case 'BAD_REQUEST':
			return new ORPCError('BAD_REQUEST', { message: decoded.message });
	}
}
