import { describe, expect, test } from 'vitest';
import { actorFacts, grantSubjectKey, joinedPolicy, policy, sketchPolicy } from '../../../src/server/db/policy';
import { workspaceSchema } from '../../../src/server/db/workspace.schema';

describe('workspace policies (draft)', () => {
	test.each([
		['sketch', sketchPolicy],
		['joined', joinedPolicy],
		['flat', policy]
	] as const)('%s compiles against the workspace schema', (_name, p) => {
		const compiled = p.compile(workspaceSchema);
		expect(Object.keys(compiled.models)).toEqual(expect.arrayContaining(['page', 'teamspace', 'teamspaceMember', 'grant']));
		expect(Object.keys(compiled.models.page!.predicates)).toContain('read');
	});
});

describe('actor facts', () => {
	const teamspaces = [
		{ id: 'open', defaultLevel: 'update' },
		{ id: 'ro', defaultLevel: 'read' }
	];

	test('a member gets the default level of each teamspace and every level below it', () => {
		const actor = actorFacts({
			userId: 'u1',
			role: 'member',
			memberships: [
				{ teamspaceId: 'open', role: 'member' },
				{ teamspaceId: 'ro', role: 'member' }
			],
			teamspaces
		});
		expect(actor.admin).toBe(false);
		expect(actor.guest).toBe(false);
		expect(actor.teamspaces).toEqual({ read: ['open', 'ro'], comment: ['open'], update: ['open'], full: [] });
		expect(actor.subjects).toEqual(['user:u1', 'workspace', 'teamspace:open', 'teamspace:ro']);
	});

	test('a teamspace owner holds every level whatever the default', () => {
		const actor = actorFacts({ userId: 'u1', role: 'member', memberships: [{ teamspaceId: 'ro', role: 'owner' }], teamspaces });
		expect(actor.teamspaces.full).toEqual(['ro']);
	});

	test('guests and anonymous visitors do not match workspace-wide shares; a token matches its public link', () => {
		const guest = actorFacts({ userId: 'g', role: 'guest', memberships: [], teamspaces });
		expect(guest.guest).toBe(true);
		expect(guest.subjects).toEqual(['user:g']);
		const visitor = actorFacts({ role: 'anonymous', shareToken: 'abc', memberships: [], teamspaces });
		expect(visitor.userId).toBeUndefined();
		expect(visitor.subjects).toEqual(['public:abc']);
	});

	test('owners and admins are admins', () => {
		for (const role of ['owner', 'admin'] as const)
			expect(actorFacts({ userId: 'a', role, memberships: [], teamspaces }).admin).toBe(true);
	});

	test('grant subject keys match the keys actors carry', () => {
		expect(grantSubjectKey('user', 'u1')).toBe('user:u1');
		expect(grantSubjectKey('teamspace', 'ts')).toBe('teamspace:ts');
		expect(grantSubjectKey('workspace')).toBe('workspace');
		expect(grantSubjectKey('public', null, 'tok')).toBe('public:tok');
	});
});
