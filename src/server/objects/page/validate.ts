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
		const allowed = access === undefined || !CANNOT_EDIT.has(access);
		if (allowed && (frame.touched.length > 0 || frame.dataChanged) && kv.get<string>(LAST_EDITOR) !== frame.user) {
			kv.put(LAST_EDITOR, frame.user);
		}
		return allowed;
	};
}
