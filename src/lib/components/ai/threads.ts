/**
 * Thread history of the Ask AI panel, kept in the browser (`localStorage`, per user and workspace): a few recent
 * conversations the person can reopen. Written against a `Storage`-like object so it runs in tests.
 */
import type { Citation } from './ask.ts';

export interface StoredMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	citations?: Citation[];
}

export interface StoredThread {
	id: string;
	title: string;
	/** The server's thread id (`done.threadId`), when it gave one. */
	serverId?: string;
	updatedAt: number;
	messages: StoredMessage[];
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const MAX_THREADS = 20;
export const MAX_MESSAGES = 60;

export const newId = (): string => `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A thread's title: the first question, shortened. */
export function titleOf(messages: readonly StoredMessage[]): string {
	const first = messages.find((m) => m.role === 'user')?.content.trim().replace(/\s+/g, ' ') ?? '';
	return first ? (first.length > 48 ? `${first.slice(0, 47)}…` : first) : 'New chat';
}

const isMessage = (m: unknown): m is StoredMessage =>
	typeof m === 'object' && m !== null && typeof (m as StoredMessage).id === 'string' && ((m as StoredMessage).role === 'user' || (m as StoredMessage).role === 'assistant') && typeof (m as StoredMessage).content === 'string';

export class ThreadStore {
	readonly #storage: KeyValueStorage | null;
	readonly #key: string;

	constructor(storage: KeyValueStorage | null, key: string) {
		this.#storage = storage;
		this.#key = key;
	}

	list(): StoredThread[] {
		try {
			const raw = JSON.parse(this.#storage?.getItem(this.#key) ?? '[]');
			if (!Array.isArray(raw)) return [];
			return raw
				.filter((t): t is StoredThread => typeof t?.id === 'string' && Array.isArray(t.messages))
				.map((t) => ({ ...t, title: typeof t.title === 'string' ? t.title : 'New chat', updatedAt: Number(t.updatedAt) || 0, messages: t.messages.filter(isMessage) }))
				.sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			return [];
		}
	}

	get(id: string): StoredThread | undefined {
		return this.list().find((t) => t.id === id);
	}

	/** Saves a thread (an empty one is dropped), newest first, capped. */
	save(thread: StoredThread): void {
		const rest = this.list().filter((t) => t.id !== thread.id);
		const messages = thread.messages.slice(-MAX_MESSAGES);
		const next = messages.length ? [{ ...thread, messages }, ...rest] : rest;
		this.#write(next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS));
	}

	remove(id: string): void {
		this.#write(this.list().filter((t) => t.id !== id));
	}

	clear(): void {
		this.#write([]);
	}

	#write(threads: StoredThread[]): void {
		try {
			this.#storage?.setItem(this.#key, JSON.stringify(threads));
		} catch {
			// quota or private mode: the history is a convenience
		}
	}
}
