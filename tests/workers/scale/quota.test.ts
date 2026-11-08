/** "Page document size: warn at 80% of the quota, also shown to the user" (docs/PLAN.md "Operating targets"). */
import { describe, expect, test } from 'vitest';
import type { ServerMessage } from '../../../src/lib/shared/protocol';
import { connect } from '../socket/helpers';
import { createWorkspace, inside } from '../workspace/helpers';

describe('document quota warning', () => {
	test('the Workspace DO pushes a quota message to tabs that can read the page, replays it on hello, and clears it', async () => {
		const ws = await createWorkspace('quota');
		const page = (await inside(ws.stub, (sql) => sql.exec<{ id: string }>('SELECT id FROM page LIMIT 1').one())).id;
		const reader = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
		await reader.rawHello({ subs: [] }).wait((m) => m.t === 'head');

		await ws.stub.pageQuota(page, 14_000_000, 16_000_000);
		const pushed = (await reader.log.wait((m) => m.t === 'quota')) as Extract<ServerMessage, { t: 'quota' }>;
		expect(pushed).toMatchObject({ pageId: page, bytes: 14_000_000, limit: 16_000_000 });

		// A tab that connects later is told as part of its hello.
		const late = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
		late.rawHello({ subs: [] });
		const replayed = (await late.log.wait((m) => m.t === 'quota')) as Extract<ServerMessage, { t: 'quota' }>;
		expect(replayed.pageId).toBe(page);

		// Under the warning share the page is forgotten: nothing is replayed.
		await ws.stub.pageQuota(page, 0, 16_000_000);
		const after = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
		const log = after.rawHello({ subs: [] });
		await log.wait((m) => m.t === 'head');
		expect(log.of('quota')).toHaveLength(0);
		for (const c of [reader, late, after]) c.ws.close();
	});

	test('a person who cannot read the page is not told', async () => {
		const ws = await createWorkspace('quota-private');
		const page = (await inside(ws.stub, (sql) => sql.exec<{ id: string }>('SELECT id FROM page LIMIT 1').one())).id;
		const stranger = await connect(ws.id, { 'x-flarion-dev-actor': 'guest-9', 'x-flarion-dev-role': 'guest' });
		const log = stranger.rawHello({ subs: [] });
		await log.wait((m) => m.t === 'head');
		await ws.stub.pageQuota(page, 15_000_000, 16_000_000);
		await new Promise((r) => setTimeout(r, 60));
		expect(log.of('quota')).toHaveLength(0);
		stranger.ws.close();
	});
});
