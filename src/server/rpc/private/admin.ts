/**
 * `admin` procedures of the private contract: the SLO dashboard's data (`admin/slo.ts`). Metrics span every workspace,
 * so the call needs the owner role of the caller's workspace and, when the `ADMIN_EMAILS` var lists addresses
 * (comma separated), the caller's email must be one of them.
 */
import { ORPCError } from '@orpc/server';
import { sloReport } from '../../admin/slo';
import { os, requireWorkspace } from './base';

const allowed = (env: { ADMIN_EMAILS?: string }, email: string): boolean => {
	const list = (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
	return list.length === 0 || list.includes(email.toLowerCase());
};

export const adminHandlers = {
	slo: os.admin.slo.use(requireWorkspace).handler(({ context }) => {
		if (context.actor.role !== 'owner' || !allowed(context.env, context.session.email)) {
			throw new ORPCError('FORBIDDEN', { message: 'Only the workspace owner can see the operating dashboard' });
		}
		return sloReport(context.env);
	})
};
