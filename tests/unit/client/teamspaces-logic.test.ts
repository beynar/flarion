import { describe, expect, it } from 'vitest';
import { LEVELS, levelLabel, levelRank, privacyLabel } from '#lib/components/teamspaces/levels.ts';
import { canManageTeamspace, isLastOwner, joinAction, memberCandidates, sortTeamspaceMembers, splitTeamspaces } from '#lib/components/teamspaces/logic.ts';
import type { Member, Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';

const ts = (id: string, privacy: Teamspace['privacy'], myRole: Teamspace['myRole'], name = id): Teamspace => ({
	id,
	name,
	icon: null,
	description: '',
	privacy,
	defaultLevel: 'update',
	createdBy: 'u_grace',
	myRole
});
const tm = (userId: string, role: 'owner' | 'member'): TeamspaceMember => ({ teamspaceId: 't', userId, role, rank: '10' });
const mem = (userId: string, name: string, role: Member['role'] = 'member'): Member => ({
	userId,
	name,
	email: `${userId}@acme.example`,
	image: null,
	role,
	joinedAt: ''
});

describe('levels', () => {
	it('lists the four levels strongest first', () => {
		expect(LEVELS.map((l) => l.label)).toEqual(['Full access', 'Can edit', 'Can comment', 'Can view']);
		expect(LEVELS.map((l) => levelRank(l.value))).toEqual([4, 3, 2, 1]);
		expect(levelLabel('read')).toBe('Can view');
		expect(privacyLabel('closed')).toBe('Closed');
	});
});

describe('joinAction', () => {
	it('joins open ones in one click, asks for closed ones, never lists private ones to outsiders', () => {
		expect(joinAction(ts('a', 'open', null))).toBe('join');
		expect(joinAction(ts('a', 'closed', null))).toBe('request');
		expect(joinAction(ts('a', 'private', null))).toBe('invite-only');
		expect(joinAction(ts('a', 'private', 'member'))).toBe('member');
	});
	it('splits mine from the browse list and hides private teamspaces I am not in', () => {
		const mine = [ts('e', 'open', 'member', 'Engineering')];
		const list = [mine[0], ts('m', 'open', null, 'Marketing'), ts('l', 'closed', null, 'Leadership'), ts('f', 'private', null, 'Finance')];
		const out = splitTeamspaces(list, mine);
		expect(out.mine.map((t) => t.id)).toEqual(['e']);
		expect(out.browse.map((t) => t.name)).toEqual(['Leadership', 'Marketing']);
	});
});

describe('members', () => {
	it('lets owners and admins manage', () => {
		expect(canManageTeamspace({ myRole: 'owner' }, false)).toBe(true);
		expect(canManageTeamspace({ myRole: 'member' }, false)).toBe(false);
		expect(canManageTeamspace({ myRole: null }, true)).toBe(true);
	});
	it('knows the last owner', () => {
		expect(isLastOwner([tm('a', 'owner'), tm('b', 'member')], 'a')).toBe(true);
		expect(isLastOwner([tm('a', 'owner'), tm('b', 'owner')], 'a')).toBe(false);
		expect(isLastOwner([tm('a', 'owner')], 'b')).toBe(false);
	});
	it('suggests workspace members who are not in yet, guests excluded', () => {
		const all = [mem('a', 'Ada'), mem('b', 'Bob'), mem('g', 'Guest', 'guest'), mem('c', 'Cleo')];
		expect(memberCandidates(all, [tm('a', 'owner')], '').map((m) => m.userId)).toEqual(['b', 'c']);
		expect(memberCandidates(all, [], 'cle').map((m) => m.userId)).toEqual(['c']);
	});
	it('sorts owners first, then by name', () => {
		const names = new Map([['a', 'Zed'], ['b', 'Amy'], ['c', 'Bea']]);
		expect(sortTeamspaceMembers([tm('b', 'member'), tm('a', 'owner'), tm('c', 'member')], names).map((m) => m.userId)).toEqual(['a', 'b', 'c']);
	});
});
