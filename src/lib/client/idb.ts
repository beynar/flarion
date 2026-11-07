/**
 * The instant-start cache: the last tree and a few recent page windows per workspace, kept in
 * IndexedDB so the sidebar paints before the socket answers (page bodies are cached by edytor).
 * `CacheBackend` is the seam: tests and browsers without IndexedDB use `MemoryCache`.
 */
import type { PageRow, TreeRow } from '#lib/shared/protocol.ts';

export interface CacheSnapshot {
	workspaceId: string;
	/** The log position the rows were consistent at. */
	seq: number | null;
	/** Parents whose children are in `tree`: the expanded branches (`null` is the root level). */
	expanded: (string | null)[];
	tree: TreeRow[];
	/** Recently opened pages with their properties. */
	pages: PageRow[];
	savedAt: number;
}

export interface CacheBackend {
	load(workspaceId: string): Promise<CacheSnapshot | null>;
	save(snapshot: CacheSnapshot): Promise<void>;
	clear(workspaceId: string): Promise<void>;
}

export class MemoryCache implements CacheBackend {
	readonly data = new Map<string, CacheSnapshot>();
	async load(workspaceId: string) {
		const s = this.data.get(workspaceId);
		return s ? structuredClone(s) : null;
	}
	async save(snapshot: CacheSnapshot) {
		this.data.set(snapshot.workspaceId, structuredClone(snapshot));
	}
	async clear(workspaceId: string) {
		this.data.delete(workspaceId);
	}
}

const DB_NAME = 'flarion';
const STORE = 'workspace-cache';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'workspaceId' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = fn(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

/** IndexedDB, one record per workspace. Every failure degrades to "no cache". */
export class IdbCache implements CacheBackend {
	#db: Promise<IDBDatabase> | null = null;
	#open(): Promise<IDBDatabase> {
		return (this.#db ??= openDb());
	}
	async load(workspaceId: string) {
		try {
			const db = await this.#open();
			return ((await run(db, 'readonly', (s) => s.get(workspaceId))) as CacheSnapshot | undefined) ?? null;
		} catch {
			return null;
		}
	}
	async save(snapshot: CacheSnapshot) {
		try {
			const db = await this.#open();
			await run(db, 'readwrite', (s) => s.put(snapshot));
		} catch {
			// quota or private mode: the cache is an optimization
		}
	}
	async clear(workspaceId: string) {
		try {
			const db = await this.#open();
			await run(db, 'readwrite', (s) => s.delete(workspaceId));
		} catch {
			// ignore
		}
	}
}

/** The best backend this environment offers. */
export function defaultCache(): CacheBackend {
	return typeof indexedDB === 'undefined' ? new MemoryCache() : new IdbCache();
}
