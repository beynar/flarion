import type { Actor } from '../../auth/session';
import type { SocketActor } from './socket';

/** What a workspace socket stores in its attachment (a few hundred bytes, well under the 2,048 cap). */
export type WorkspaceSocketActor = Actor & SocketActor;

/**
 * Where P2 plugs in the viborm policy: the object's writes and reads all go through here. Until then the
 * "visibility set" is every live page (docs/PLAN.md "Implementation phases", stand-ins), so the scope key
 * is constant and every actor shares each subscription unit.
 */
export const VISIBILITY_SCOPE_ALL = 'all';
export const visibilityScope = (_actor: Actor): string => VISIBILITY_SCOPE_ALL;

/** The access level a role holds on pages until P2 computes it per page (`$access`). */
export function stubAccess(role: Actor['role']): 'read' | 'update' | 'full' {
	return role === 'owner' || role === 'admin' ? 'full' : role === 'guest' ? 'read' : 'update';
}
