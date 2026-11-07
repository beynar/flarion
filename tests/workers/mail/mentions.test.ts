import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { globalClient } from '../../../src/server/db/global.client';
import type { EmailJob, PageIndexItem } from '../../../src/server/queues/types';
import { batch, createOp, createWorkspace, rankAfter, type Fixture } from '../workspace/helpers';

const testEnv = env as unknown as Env & { TEST_SQL: DurableObjectNamespace };

const item = (pageId: string, mentions: PageIndexItem['mentions'], version = 1, editedBy: string | null = 'owner-1'): PageIndexItem => ({
	pageId,
	version,
	text: 'body',
	outline: [],
	links: [],
	mentions,
	editedAt: Date.now(),
	editedBy
});

/** Email jobs that reached the queue (the test Worker's consumer logs them) for one workspace. */
async function emailJobs(workspaceId: string, pageId: string): Promise<EmailJob[]> {
	const log = testEnv.TEST_SQL.getByName('queue-log');
	return runInDurableObject(log, (_i, state) => {
		state.storage.sql.exec('CREATE TABLE IF NOT EXISTS queue_log (queue TEXT, body TEXT)');
		return state.storage.sql
			.exec<{ body: string }>('SELECT body FROM queue_log')
			.toArray()
			.map((row) => JSON.parse(row.body) as EmailJob)
			.filter((job) => job.type === 'email' && job.data.workspaceId === workspaceId && job.data.pageId === pageId);
	});
}

/** Gives the queue a moment to deliver, then returns what arrived. */
async function settledJobs(workspaceId: string, pageId: string, expected: number): Promise<EmailJob[]> {
	if (expected > 0) await vi.waitFor(async () => expect(await emailJobs(workspaceId, pageId)).toHaveLength(expected), { timeout: 15_000, interval: 100 });
	else await new Promise((resolve) => setTimeout(resolve, 2500));
	return emailJobs(workspaceId, pageId);
}

async function person(ws: Fixture, name: string, options: { notifyMentions?: boolean; member?: boolean; role?: 'member' | 'guest' } = {}) {
	const id = `u-${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`;
	const email = `${id}@example.com`;
	await globalClient(testEnv.DB).user.create({
		data: { id, name, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date(), notifyMentions: options.notifyMentions ?? true }
	});
	if (options.member !== false) {
		await ws.stub.syncMember({ userId: id, role: options.role ?? 'member', name });
		if ((options.role ?? 'member') === 'member') await ws.stub.addTeamspaceMember(ws.owner, { teamspaceId: ws.generalId, userId: id });
	}
	return { id, email, name };
}

async function newPage(ws: Fixture, id: string, title = 'Roadmap') {
	await ws.stub.apply(ws.owner, batch([createOp(id, null, rankAfter(null), { teamspaceId: ws.generalId, values: { title } })]));
	return id;
}

describe('mention emails', () => {
	test('a new mention queues one email job; the same mention again queues nothing; a new one queues just that', async () => {
		const ws = await createWorkspace('mention');
		const bea = await person(ws, 'Bea');
		const cal = await person(ws, 'Cal');
		const page = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`, 'Roadmap <2027>');

		await ws.stub.ingestPages([item(page, [{ userId: bea.id, blockId: 'b1' }])]);
		let jobs = await settledJobs(ws.id, page, 1);
		expect(jobs).toEqual([
			{
				type: 'email',
				template: 'mention',
				to: bea.email,
				data: { workspaceId: ws.id, pageId: page, pageTitle: 'Roadmap <2027>', userId: bea.id, blockId: 'b1', actorName: 'Owner' }
			}
		]);

		// The body is indexed again with the same mention (and a new version): nobody is mailed twice.
		await ws.stub.ingestPages([item(page, [{ userId: bea.id, blockId: 'b1' }], 2)]);
		// Cal is mentioned too: only Cal is mailed.
		await ws.stub.ingestPages([
			item(
				page,
				[
					{ userId: bea.id, blockId: 'b1' },
					{ userId: cal.id, blockId: 'b2' }
				],
				3
			)
		]);
		jobs = await settledJobs(ws.id, page, 2);
		expect(jobs.map((j) => j.to).sort()).toEqual([bea.email, cal.email].sort());
	});

	test('one mail per person per batch, even for two new blocks; removing and re-adding a mention mails again', async () => {
		const ws = await createWorkspace('mention-dedupe');
		const dee = await person(ws, 'Dee');
		const page = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`);
		await ws.stub.ingestPages([
			item(page, [
				{ userId: dee.id, blockId: 'b1' },
				{ userId: dee.id, blockId: 'b2' }
			])
		]);
		expect(await settledJobs(ws.id, page, 1)).toHaveLength(1);
		await ws.stub.ingestPages([item(page, [], 2)]); // the mentions are deleted
		await ws.stub.ingestPages([item(page, [{ userId: dee.id, blockId: 'b9' }], 3)]);
		expect(await settledJobs(ws.id, page, 2)).toHaveLength(2);
	});

	test('a late, older body does not reset what was seen', async () => {
		const ws = await createWorkspace('mention-order');
		const eli = await person(ws, 'Eli');
		const page = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`);
		await ws.stub.ingestPages([item(page, [{ userId: eli.id, blockId: 'b1' }], 5)]);
		await ws.stub.ingestPages([item(page, [], 2)]); // stale
		await ws.stub.ingestPages([item(page, [{ userId: eli.id, blockId: 'b1' }], 6)]);
		expect(await settledJobs(ws.id, page, 1)).toHaveLength(1);
	});

	test('nobody is mailed for a self-mention, a non-member, someone who turned mentions off, or on a trashed page', async () => {
		const ws = await createWorkspace('mention-skip');
		const fay = await person(ws, 'Fay', { notifyMentions: false });
		const stranger = await person(ws, 'Stranger', { member: false });
		const ivy = await person(ws, 'Ivy'); // the control: she is mailed, so we know the queue delivered
		const gus = await person(ws, 'Gus');
		const page = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`);
		const trashed = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`);
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: trashed } as never]));
		await ws.stub.ingestPages([
			item(page, [
				{ userId: 'owner-1', blockId: 'b0' }, // the editor mentions themselves
				{ userId: fay.id, blockId: 'b1' },
				{ userId: stranger.id, blockId: 'b2' },
				{ userId: 'ghost-user', blockId: 'b3' },
				{ userId: ivy.id, blockId: 'b4' }
			]),
			item(trashed, [{ userId: gus.id, blockId: 'b1' }])
		]);
		expect((await settledJobs(ws.id, page, 1)).map((job) => job.to)).toEqual([ivy.email]);
		expect(await emailJobs(ws.id, trashed)).toEqual([]);
	});

	test('mention state lives in meta and does not grow for pages without mentions', async () => {
		const ws = await createWorkspace('mention-meta');
		const hal = await person(ws, 'Hal');
		const page = await newPage(ws, `p-${crypto.randomUUID().slice(0, 6)}`);
		const metaKeys = () =>
			runInDurableObject(ws.stub, (_i, state) =>
				state.storage.sql.exec<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'mentions:%'").toArray().map((r) => r.key)
			);
		await ws.stub.ingestPages([item(page, [])]);
		expect(await metaKeys()).toEqual([]);
		await ws.stub.ingestPages([item(page, [{ userId: hal.id, blockId: 'b1' }], 2)]);
		expect(await metaKeys()).toEqual([`mentions:${page}`]);
		await ws.stub.ingestPages([item(page, [], 3)]);
		expect(await metaKeys()).toEqual([]);
	});
});
