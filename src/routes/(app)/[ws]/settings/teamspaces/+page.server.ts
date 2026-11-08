import { shellOf } from '../../../../../server/ssr/shell';
import type { TeamspaceMember } from '../../../../../lib/shared/schemas';
import type { PageServerLoad } from './$types';

/** Each teamspace's roster and the archived teamspaces the person owns, as the actor sees them. */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { initial: null };
	const { actor, stub } = await shellOf(event);
	const [list, archived] = await Promise.all([stub.teamspaces(actor), stub.archivedTeamspaces(actor).catch(() => [])]);
	const rosters: Record<string, TeamspaceMember[]> = {};
	await Promise.all(
		list.map(async (t) => {
			try {
				rosters[t.id] = await stub.teamspaceMembers(actor, t.id);
			} catch {
				// a roster the person may not read: the column shows nothing, as it does in the browser
			}
		})
	);
	return { initial: { rosters, archived } };
};
