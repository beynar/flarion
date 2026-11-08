/** A workspace is created near the person who created it (docs/PLAN.md "Performance, limits and scaling"). */
import { describe, expect, test } from 'vitest';
import { createWorkspace } from '../../../src/server/auth/workspaces';
import { createWorld, signUpPerson, verifyEmail } from '../auth/helpers';

describe('location hint at workspace creation', () => {
	test('the first contact with the Workspace DO carries the hint of request.cf, and later calls none', async () => {
		const world = createWorld();
		const ada = await signUpPerson(world, 'Ada', 'ada-hint@example.com');
		await verifyEmail(world, ada);
		const calls: { name: string; options: unknown }[] = [];
		const namespace = { getByName: (name: string, options?: unknown) => (calls.push({ name, options }), world.workspaces.getByName(name)) };
		const env = { ...world.env, WORKSPACE: namespace } as unknown as Env;
		const session = { userId: ada.userId, sessionId: 's-hint', name: ada.name, email: ada.email, emailVerified: true };
		const request = new Request('https://flarion.test/rpc', { cf: { continent: 'EU', country: 'DE', longitude: '13.4' } as never });
		const created = await createWorkspace({ env, ctx: world.ctx, request }, session, { name: 'Berlin team' });
		await world.settle();
		const first = calls.filter((c) => c.name === created.id);
		expect(first[0].options).toEqual({ locationHint: 'weur' });
		// Everything after `init` (member syncs, renames) reaches the existing object without a hint.
		expect(first.slice(1).every((c) => c.options === undefined)).toBe(true);
		expect(world.workspaces.inits.map((i) => i.workspaceId)).toContain(created.id);
		expect(world.workspaces.inits.find((i) => i.workspaceId === created.id)).not.toHaveProperty('locationHint');
	});

	test('without geography (local dev, tests) the object is created without a hint', async () => {
		const world = createWorld();
		const bob = await signUpPerson(world, 'Bob', 'bob-hint@example.com');
		await verifyEmail(world, bob);
		const calls: { name: string; options: unknown }[] = [];
		const namespace = { getByName: (name: string, options?: unknown) => (calls.push({ name, options }), world.workspaces.getByName(name)) };
		const env = { ...world.env, WORKSPACE: namespace } as unknown as Env;
		const session = { userId: bob.userId, sessionId: 's-hint2', name: bob.name, email: bob.email, emailVerified: true };
		const created = await createWorkspace({ env, ctx: world.ctx, request: new Request('https://flarion.test/rpc') }, session, { name: 'Nowhere' });
		await world.settle();
		expect(calls.filter((c) => c.name === created.id).every((c) => c.options === undefined)).toBe(true);
	});
});
