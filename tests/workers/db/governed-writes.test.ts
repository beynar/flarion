/**
 * What a governed (`$as`) write does when the policy does not let the actor through, on our Durable Object driver
 * and our policy (viborm 1.12.1). The audit (docs/audits/viborm-limitations.md, #2) said a governed `update` or
 * `delete` "does nothing, silently"; the viborm maintainers' review showed it does not, and this test pins what it
 * does (`NotFoundError` V6001, nested writes `NestedWriteError` V7001, `upsert` `ForbiddenError`, and only
 * `updateMany` / `deleteMany` answer `{ count: 0 }`), which `page-ops.ts` and `teamspaces.ts` rely on.
 */
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createMigrationClient } from 'viborm/migrations';
import { createDurableObjectSqliteClient } from '../../../src/server/db/driver/client';
import { actorFacts, policy } from '../../../src/server/db/policy';
import { WORKSPACE_TABLES, workspaceSchema } from '../../../src/server/db/workspace.schema';
import { canRead, orExplain } from '../../../src/server/objects/workspace/governed';
import { notFound, WorkspaceError } from '../../../src/server/objects/workspace/errors';
import { testEnv } from '../helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const LEVELS = [
	{ id: 'ts0', defaultLevel: 'read' }, // alice: member (reads); bob: owner
	{ id: 'ts1', defaultLevel: 'update' } // alice: not a member (private)
];

async function world<T>(fn: (ctx: { base: Any; alice: Any; bob: Any; guest: Any }) => Promise<T>): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName('governed-writes-' + crypto.randomUUID());
	return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const base: Any = createDurableObjectSqliteClient(state.storage, workspaceSchema);
		const migrations = createMigrationClient(base, { tables: [...WORKSPACE_TABLES] });
		await migrations.push({ consent: (await migrations.push({ dryRun: true })).consent });
		await base.teamspace.create({ data: { id: 'ts0', name: 'ts0', privacy: 'open', defaultLevel: 'read', createdBy: 'bob' } });
		await base.teamspace.create({ data: { id: 'ts1', name: 'ts1', privacy: 'private', defaultLevel: 'update', createdBy: 'bob' } });
		await base.teamspaceMember.create({ data: { teamspaceId: 'ts0', userId: 'alice', role: 'member' } });
		await base.teamspaceMember.create({ data: { teamspaceId: 'ts0', userId: 'bob', role: 'owner' } });
		await base.teamspaceMember.create({ data: { teamspaceId: 'ts1', userId: 'bob', role: 'owner' } });
		let num = 1;
		const page = (id: string, parentId: string | null, teamspaceId: string | null) =>
			base.page.create({ data: { id, num: num++, parentId, teamspaceId, rank: 'a', createdById: 'bob' } });
		await page('R', null, 'ts0'); // alice reads it (member at read), cannot update it
		await page('H', null, 'ts1'); // hidden from alice
		await page('W', null, 'ts0');
		await base.grant.create({ data: { id: 'gw', pageId: 'W', subjectKind: 'user', subjectId: 'alice', subjectKey: 'user:alice', level: 'update', createdBy: 'bob' } });
		const facts = (userId: string, role: 'member' | 'guest', memberships: { teamspaceId: string; role: string }[]) =>
			actorFacts({ userId, role, memberships, teamspaces: LEVELS });
		const governed = (policy as Any)(base);
		return fn({
			base,
			alice: governed.$as(facts('alice', 'member', [{ teamspaceId: 'ts0', role: 'member' }])),
			bob: governed.$as(facts('bob', 'member', [{ teamspaceId: 'ts0', role: 'owner' }, { teamspaceId: 'ts1', role: 'owner' }])),
			guest: governed.$as(facts('g', 'guest', []))
		});
	});
}

const failure = async (run: Promise<unknown> | (() => Promise<unknown>)) => {
	try {
		await (typeof run === 'function' ? run() : run);
	} catch (error) {
		return error as Error & { code?: string };
	}
	return null;
};
const named = (error: (Error & { code?: string }) | null) => (error ? `${error.constructor.name} ${error.code ?? ''}`.trim() : 'no error');

test('a governed single-row update or delete the actor may not do throws NotFoundError, never a silent no-op', async () => {
	await world(async ({ base, alice }) => {
		const title = (id: string) => alice.page.update({ where: { id }, data: { title: 'x' } });
		expect(named(await failure(title('R')))).toBe('NotFoundError V6001'); // readable, not updatable
		expect(named(await failure(title('H')))).toBe('NotFoundError V6001'); // hidden
		expect(named(await failure(title('NOPE')))).toBe('NotFoundError V6001'); // missing: the same answer as hidden
		expect(named(await failure(alice.page.delete({ where: { id: 'R' } })))).toBe('NotFoundError V6001');
		expect(named(await failure(alice.page.delete({ where: { id: 'H' } })))).toBe('NotFoundError V6001');
		expect(named(await failure(alice.teamspace.update({ where: { id: 'ts0' }, data: { name: 'x' } })))).toBe('NotFoundError V6001');
		expect(named(await failure(alice.teamspace.update({ where: { id: 'ts1' }, data: { name: 'x' } })))).toBe('NotFoundError V6001');
		expect(named(await failure(alice.teamspaceMember.delete({ where: { teamspaceId_userId: { teamspaceId: 'ts0', userId: 'bob' } } })))).toBe('NotFoundError V6001');
		// inside a transaction too (what `runCommit` does)
		expect(named(await failure(alice.$transaction((tx: Any) => tx.page.update({ where: { id: 'R' }, data: { title: 'x' } }))))).toBe('NotFoundError V6001');
		// and the row the actor may edit goes through
		expect((await alice.page.update({ where: { id: 'W' }, data: { title: 'ok' } })).title).toBe('ok');
		expect((await base.page.findUnique({ where: { id: 'R' } })).title).toBe('');
		expect(await base.page.count({ where: { id: { in: ['R', 'H'] } } })).toBe(2);
	});
});

test('nested writes are refused under $as (NestedWriteError) and upsert is Forbidden', async () => {
	await world(async ({ guest, alice }) => {
		const nested = await failure(alice.page.update({ where: { id: 'W' }, data: { grants: { update: { where: { id: 'gw' }, data: { level: 'full' } } } } }));
		expect(named(nested)).toBe('NestedWriteError V7001');
		const nestedCreate = await failure(
			alice.page.update({ where: { id: 'W' }, data: { children: { create: { id: 'C', num: 90, rank: 'a', createdById: 'alice', teamspaceId: 'ts1' } } } })
		);
		expect(named(nestedCreate)).toBe('NestedWriteError V7001'); // a row the create rule refuses (another teamspace than its parent's)
		const upsert = await failure(
			alice.page.upsert({ where: { id: 'R' }, create: { id: 'R', num: 91, rank: 'a', createdById: 'alice', teamspaceId: 'ts0' }, update: { title: 'x' } })
		);
		expect(named(upsert)).toBe('ForbiddenError V13001');
		expect(named(await failure(guest.page.update({ where: { id: 'R' }, data: { title: 'x' } })))).toBe('NotFoundError V6001');
	});
});

test('only updateMany and deleteMany answer { count: 0 } when the policy lets no row through', async () => {
	await world(async ({ base, alice, bob }) => {
		expect(await alice.page.updateMany({ where: { id: 'R' }, data: { title: 'x' } })).toEqual({ count: 0 });
		expect(await alice.page.updateMany({ where: { id: { in: ['R', 'H', 'NOPE'] } }, data: { title: 'x' } })).toEqual({ count: 0 });
		expect(await alice.page.deleteMany({ where: { id: 'H' } })).toEqual({ count: 0 });
		// a mixed set updates exactly the rows the actor may edit
		expect(await alice.page.updateMany({ where: { id: { in: ['R', 'W'] } }, data: { title: 'mixed' } })).toEqual({ count: 1 });
		expect((await base.page.findUnique({ where: { id: 'R' } })).title).toBe('');
		expect((await base.page.findUnique({ where: { id: 'W' } })).title).toBe('mixed');
		expect(await bob.page.updateMany({ where: { id: { in: ['R', 'H', 'W'] } }, data: { title: 'all' } })).toEqual({ count: 3 });
	});
});

test("`can` tells a hidden row from a readable one: the pre-check Flarion keeps for the 404 / 403 split", async () => {
	await world(async ({ alice }) => {
		expect(await alice.page.can('read', { id: 'R' })).toBe(true);
		expect(await alice.page.can('update', { id: 'R' })).toBe(false);
		expect(await alice.page.can('read', { id: 'H' })).toBe(false);
		expect(await alice.page.can('read', { id: 'NOPE' })).toBe(false);
	});
});

test('orExplain turns the refusal into 404 for a page the actor cannot read and 403 for one they can, with one query after the write', async () => {
	await world(async ({ alice }) => {
		const attempt = (id: string) =>
			failure(
				orExplain(
					() => alice.page.update({ where: { id }, data: { title: 'x' } }),
					async () => ((await canRead(alice.page, { id })) ? new WorkspaceError('FORBIDDEN', 'no') : notFound(`Page "${id}"`))
				)
			);
		expect(((await attempt('R')) as WorkspaceError).code).toBe('FORBIDDEN'); // readable, not updatable
		expect(((await attempt('H')) as WorkspaceError).code).toBe('NOT_FOUND'); // hidden
		expect(((await attempt('NOPE')) as WorkspaceError).code).toBe('NOT_FOUND'); // missing
		// an allowed write goes through with no explanation, and other errors pass through untouched
		const fine = (await orExplain(() => alice.page.update({ where: { id: 'W' }, data: { title: 'fine' } }), async () => new WorkspaceError('FORBIDDEN', 'no'))) as { title: string };
		expect(fine.title).toBe('fine');
		const boom = new Error('boom');
		await expect(orExplain(() => Promise.reject(boom), async () => new WorkspaceError('FORBIDDEN', 'no'))).rejects.toBe(boom);
	});
});
