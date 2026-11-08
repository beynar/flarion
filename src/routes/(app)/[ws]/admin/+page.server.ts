import { env } from 'cloudflare:workers';
import { server } from '../../../../server/ssr/server';
import { shellOf } from '../../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

/** The owner's operating dashboard: the same gate as `admin.slo` (owner, and `ADMIN_EMAILS` when set), else nothing (the page says so). */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { slo: null };
	const { workspace, session } = await shellOf(event);
	const list = (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
	if (workspace.role !== 'owner' || (list.length > 0 && !list.includes(session.email.toLowerCase()))) return { slo: null };
	try {
		return { slo: await (await server()).sloReport(env) };
	} catch {
		return { slo: null };
	}
};
