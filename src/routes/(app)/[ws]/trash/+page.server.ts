import { shellOf } from '../../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** The first page of the Trash (newest first), read as the actor. A client-side navigation has none: the screen asks for it, as it always did. */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { trash: null };
	const { actor, stub } = await shellOf(event);
	return { trash: await stub.listTrash(actor, { sort: 'deleted_desc', limit: 50 }) };
};
