/**
 * Page Durable Object names. A room is named `workspaceId:pageId`, with the workspace id taken from a
 * verified token, so a room can never be reached from another workspace (docs/PLAN.md "Security and
 * reliability"). Neither part is user-chosen free text: both are server-generated ids.
 */

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const isValidRoomId = (id: string): boolean => ID.test(id);

/** The Durable Object name of a page's room. */
export function roomName(workspaceId: string, pageId: string): string {
	if (!isValidRoomId(workspaceId) || !isValidRoomId(pageId)) throw new Error('invalid workspace or page id');
	return `${workspaceId}:${pageId}`;
}

/** Inverse of {@link roomName}; `null` for a name not made by it. */
export function parseRoomName(name: string | undefined | null): { workspaceId: string; pageId: string } | null {
	if (!name) return null;
	const at = name.indexOf(':');
	if (at < 0) return null;
	const workspaceId = name.slice(0, at);
	const pageId = name.slice(at + 1);
	return isValidRoomId(workspaceId) && isValidRoomId(pageId) ? { workspaceId, pageId } : null;
}
