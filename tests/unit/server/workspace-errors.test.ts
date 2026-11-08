import { ORPCError } from '@orpc/server';
import { describe, expect, test } from 'vitest';
import { mapWorkspaceError, isObjectOverloaded } from '../../../src/server/rpc/private/workspace-errors';

describe('a busy Durable Object', () => {
	test('is a 503 the client retries, not an internal error (staging answered 500 to 519 of 600 writes)', () => {
		for (const error of [
			new Error('Durable Object is overloaded. Requests queued for too long.'),
			new Error('Durable Object is overloaded. Too many requests queued.'),
			Object.assign(new Error('something else'), { overloaded: true })
		]) {
			expect(isObjectOverloaded(error)).toBe(true);
			const mapped = mapWorkspaceError(error);
			expect(mapped).toBeInstanceOf(ORPCError);
			expect(mapped).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
		}
	});

	test('leaves other errors alone', () => {
		const boom = new Error('boom');
		expect(isObjectOverloaded(boom)).toBe(false);
		expect(mapWorkspaceError(boom)).toBe(boom);
		const orpc = new ORPCError('FORBIDDEN');
		expect(mapWorkspaceError(orpc)).toBe(orpc);
	});
});
