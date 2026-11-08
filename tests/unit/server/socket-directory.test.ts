import { describe, expect, test } from 'vitest';
import { SocketDirectory, type DirectorySocket } from '../../../src/server/objects/workspace/socket-directory';

type A = { userId: string; role: string };
const socket = (socketId: string, userId: string, role = 'member'): DirectorySocket<A> => ({ ws: {} as WebSocket, socketId, actor: { userId, role } });

describe('SocketDirectory', () => {
	test('finds sockets by id and lists them', () => {
		const dir = new SocketDirectory<A>([socket('a', 'u1'), socket('b', 'u2')]);
		expect(dir.size).toBe(2);
		expect(dir.get('a')?.actor.userId).toBe('u1');
		expect(dir.get('zzz')).toBeNull();
		expect(dir.all().map((s) => s.socketId)).toEqual(['a', 'b']);
	});

	test('keeps one actor per user and role until their last socket is gone', () => {
		const dir = new SocketDirectory<A>();
		dir.add(socket('a', 'u1'));
		dir.add(socket('b', 'u1'));
		dir.add(socket('c', 'u1', 'guest'));
		dir.add(socket('d', 'u2'));
		expect(dir.actors().map((a) => `${a.userId}|${a.role}`).sort()).toEqual(['u1|guest', 'u1|member', 'u2|member']);
		dir.remove('a');
		expect(dir.actors()).toHaveLength(3);
		dir.remove('b');
		expect(dir.actors().map((a) => `${a.userId}|${a.role}`).sort()).toEqual(['u1|guest', 'u2|member']);
		dir.remove('missing');
		expect(dir.size).toBe(2);
	});

	test('adding a socket id again replaces it without double counting its actor', () => {
		const dir = new SocketDirectory<A>();
		dir.add(socket('a', 'u1'));
		dir.add(socket('a', 'u1'));
		expect(dir.size).toBe(1);
		dir.remove('a');
		expect(dir.actors()).toEqual([]);
	});
});
