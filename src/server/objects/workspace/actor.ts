import type { Actor } from '../../auth/session';
import type { SocketActor } from './socket';

/** What a workspace socket stores in its attachment (a few hundred bytes, well under the 2,048 cap). */
export type WorkspaceSocketActor = Actor & SocketActor;

/**
 * Subscription units are shared by every actor: a unit holds the ids a query returns, and each socket's
 * window is that list ANDed with ITS visibility set (`access.ts`) when a snapshot or a diff is built. So the
 * scope key of a unit stays constant (docs/PLAN.md "Real-time sync": "intersects it with the actor's
 * visibility set").
 */
export const VISIBILITY_SCOPE_ALL = 'all';
export const visibilityScope = (_actor: Actor): string => VISIBILITY_SCOPE_ALL;

/** A role-based stand-in for a page level (no longer used by the live loop: rows carry the real `$access`). */
export function stubAccess(role: Actor['role']): 'read' | 'update' | 'full' {
	return role === 'owner' || role === 'admin' ? 'full' : role === 'guest' ? 'read' : 'update';
}
