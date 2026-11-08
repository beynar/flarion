/**
 * `Idempotency-Key` for the public API's writes (docs/PLAN.md "API"): the keys live 24 hours in the Workspace DO
 * (`objects/workspace/idempotency.ts`). Only a successful write is remembered: a retry of one that failed simply runs
 * again, so a key can never lock a client into an error.
 */
import { ORPCError } from '@orpc/server';
import { sha256Hex } from '../../auth/crypto';
import type { ApiAuth } from './base';

/**
 * Runs `run` once per `(token, key)`. The same key with the same request replays the stored answer; with a different
 * request it is `IDEMPOTENCY_CONFLICT` (409); while the first is still running it is a plain `CONFLICT` (retry soon).
 * Without a key `run` just runs.
 */
export async function idempotent<T>(auth: ApiAuth, key: string | undefined, request: { operation: string; input: unknown }, run: () => Promise<T>): Promise<T> {
	if (!key) return run();
	const hash = await sha256Hex(JSON.stringify([request.operation, request.input]));
	const claim = await auth.workspace.idempotencyBegin(auth.tokenId, key, hash);
	switch (claim.state) {
		case 'replay':
			return JSON.parse(claim.body) as T;
		case 'conflict':
			throw new ORPCError('IDEMPOTENCY_CONFLICT', { status: 409, message: 'Idempotency-Key reused with a different request' });
		case 'in_flight':
			throw new ORPCError('CONFLICT', { message: 'A request with this Idempotency-Key is still running. Retry shortly.' });
		case 'new':
			break;
	}
	try {
		const result = await run();
		await auth.workspace.idempotencyFinish(auth.tokenId, key, 200, JSON.stringify(result));
		return result;
	} catch (error) {
		await auth.workspace.idempotencyAbandon(auth.tokenId, key).catch(() => undefined);
		throw error;
	}
}
