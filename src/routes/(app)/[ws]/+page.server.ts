import { shellOf } from '../../../server/ssr/shell';
import { uiOf } from '../../../server/ssr/workspace';
import { PAGE_SET_ID } from '../../../lib/shared/sub-key';
import type { StoreSeed } from '../../../lib/shared/seed';
import type { PageServerLoad } from './$types';

/** Home: the recently visited and favorite pages the person's cookie names, as the one `page` window the home page holds (`watchPages`). */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { seed: {} as StoreSeed };
	const shell = await shellOf(event);
	const ui = uiOf(event.cookies, shell.workspace.id);
	// The list `+page.svelte` subscribes to: the twelve most recent, then the favorites, once each.
	const wanted = [...new Set([...ui.rec.map(([id]) => id).slice(0, 12), ...ui.fav])].slice(0, 50);
	const seed: StoreSeed = {};
	if (wanted.length) {
		const sub = { kind: 'page' as const, pageIds: wanted };
		const read = await shell.stub.ssrRead(shell.actor, { subs: [{ id: PAGE_SET_ID, sub }] });
		seed.windows = read.windows;
	}
	return { seed };
};
