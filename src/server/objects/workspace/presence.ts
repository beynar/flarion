/**
 * Presence: who is on which page. Held in memory only and never stored (docs/PLAN.md "Presence"): after
 * the object hibernates the table is empty and refills as tabs send their next `presence` message.
 */
import type { PresenceEntry, PresenceUser } from '../../../lib/shared/protocol';

const COLORS = ['#e03e3e', '#d9730d', '#dfab01', '#0f7b6c', '#0b6e99', '#6940a5', '#ad1a72', '#64473a'];
export const presenceColor = (userId: string): string => {
	let h = 0;
	for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
	return COLORS[h % COLORS.length];
};

export class Presence {
	readonly #pageOf = new Map<string, { pageId: string; user: PresenceUser }>();

	/** Moves a socket to `pageId` (null: off every page). Returns the pages whose user list changed. */
	set(socketId: string, user: PresenceUser, pageId: string | null): string[] {
		const before = this.#pageOf.get(socketId)?.pageId ?? null;
		if (before === pageId) return [];
		if (pageId === null) this.#pageOf.delete(socketId);
		else this.#pageOf.set(socketId, { pageId, user });
		return [before, pageId].filter((p): p is string => p !== null);
	}

	/** A socket went away. Returns the page it was on, if any. */
	remove(socketId: string): string[] {
		const before = this.#pageOf.get(socketId)?.pageId;
		this.#pageOf.delete(socketId);
		return before ? [before] : [];
	}

	/** The distinct users on each page, for `pageIds` (an empty list when nobody is there). */
	entries(pageIds: readonly string[]): PresenceEntry[] {
		return pageIds.map((pageId) => {
			const users = new Map<string, PresenceUser>();
			for (const entry of this.#pageOf.values()) if (entry.pageId === pageId) users.set(entry.user.userId, entry.user);
			return { pageId, users: [...users.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1)) };
		});
	}

	/** Every page somebody is on. */
	occupied(): string[] {
		return [...new Set([...this.#pageOf.values()].map((e) => e.pageId))];
	}
}
