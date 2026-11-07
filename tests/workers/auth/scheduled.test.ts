import { describe, expect, test } from 'vitest';
import { NIGHTLY_CRON, scheduled } from '../../../src/server/scheduled';
import { createWorld, signUpPerson, verifyEmail } from './helpers';

describe('nightly cron', () => {
	test('drains the outbox and reconciles memberships', async () => {
		const world = createWorld();
		const ada = await signUpPerson(world, 'Ada', 'ada-cron@example.com');
		await verifyEmail(world, ada);
		world.workspaces.failing = true;
		const created = await ada.client.rpc.workspace.create({ name: 'Cron Co' });
		world.workspaces.failing = false;
		expect(world.workspaces.inits).toHaveLength(0);
		await world.env.DB.prepare("UPDATE outbox SET nextAttemptAt = '2000-01-01T00:00:00.000Z'").run();

		const ctx = world.ctx;
		await scheduled({ cron: NIGHTLY_CRON, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, world.env, ctx as never);
		await world.settle();
		expect(world.workspaces.inits.map((i) => i.workspaceId)).toEqual([created.id]);
		expect(world.workspaces.members.get(created.id)?.get(ada.userId)).toBe('owner');
	});

	test('other crons leave identity alone', async () => {
		const world = createWorld();
		await scheduled({ cron: '0 4 * * 0', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, world.env, world.ctx as never);
		await world.settle();
		expect(world.workspaces.inits).toHaveLength(0);
	});
});
