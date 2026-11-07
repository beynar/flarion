/**
 * `validate` hook of the room: accept-then-compensate. edytor applies a client frame, then asks
 * whether to keep it; `false` makes the room write the frame's inverse (docs/PLAN.md "Pages and
 * blocks": "refuse edits from users whose access was lowered mid-session").
 *
 * The room already enforces the access of each socket (`setAccess` downgrades a socket in place).
 * This hook is the second line: it covers the window before a downgrade reaches every socket, and
 * frames from a socket that predates the change. P2's Workspace DO drives it through
 * `PageDO.setAccess`, which records the level in the object's KV storage.
 *
 * Levels that cannot edit: `read`, `comment`, `none`. No record means the room's own access applies.
 *
 * Page lock (docs/PLAN.md "Lock page"): the lock lives in the room's KV (`lock:page`). While it is set, a
 * frame that touches the document is denied (and compensated) unless its sender may bypass: users with full
 * access on the page, noted by the route at every dial (`bypass:<userId>`) and cleared when their access
 * changes. Per-block locks (`lockedBy` data, `subtree: true`) ride on edytor's `locks` option with the same bypass.
 */
import type { FrameValidation } from 'edytor/cloudflare';

export type StoredAccess = 'none' | 'read' | 'comment' | 'write' | 'suggest';

const KEY = (userId: string) => `access:${userId}`;

export function recordUserAccess(kv: SyncKvStorage, userId: string, access: StoredAccess): void {
	if (access === 'write') kv.delete(KEY(userId));
	else kv.put(KEY(userId), access);
}

export function recordedUserAccess(kv: SyncKvStorage, userId: string): StoredAccess | undefined {
	return kv.get<StoredAccess>(KEY(userId));
}

const LOCK_KEY = 'lock:page';
const BYPASS_KEY = (userId: string) => `bypass:${userId}`;

/** Who locked the page and when (ms). */
export interface PageLockRecord {
	by: string;
	at: number;
}

export const readPageLock = (kv: SyncKvStorage): PageLockRecord | null => kv.get<PageLockRecord>(LOCK_KEY) ?? null;

export function writePageLock(kv: SyncKvStorage, lock: PageLockRecord | null): void {
	if (lock) kv.put(LOCK_KEY, lock);
	else kv.delete(LOCK_KEY);
}

/** Records whether a user has full access on this page (they edit despite a lock). */
export function recordBypass(kv: SyncKvStorage, userId: string, bypass: boolean): void {
	if (bypass) kv.put(BYPASS_KEY(userId), true);
	else kv.delete(BYPASS_KEY(userId));
}

export const canBypassLock = (kv: SyncKvStorage, userId: string): boolean => kv.get<boolean>(BYPASS_KEY(userId)) === true;

const CANNOT_EDIT: ReadonlySet<StoredAccess> = new Set(['none', 'read', 'comment']);

const LAST_EDITOR = 'last_editor';

/** The user whose frame last changed the page's blocks, for the indexing job's `editedBy`. */
export function lastEditor(kv: SyncKvStorage): string | null {
	return kv.get<string>(LAST_EDITOR) ?? null;
}

/**
 * Builds the synchronous `validate` option. Returns `false` to deny a frame. A frame that is kept and
 * changed something records its sender as the page's last editor.
 */
export function createFrameValidator(kv: SyncKvStorage) {
	return (frame: FrameValidation): boolean => {
		const access = recordedUserAccess(kv, frame.user);
		let allowed = access === undefined || !CANNOT_EDIT.has(access);
		// A locked page takes no edit from anyone without full access.
		const edits = frame.touched.length > 0 || frame.dataChanged;
		if (allowed && edits && readPageLock(kv) && !canBypassLock(kv, frame.user)) allowed = false;
		if (allowed && (frame.touched.length > 0 || frame.dataChanged) && kv.get<string>(LAST_EDITOR) !== frame.user) {
			kv.put(LAST_EDITOR, frame.user);
		}
		return allowed;
	};
}
