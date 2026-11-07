/** `search` procedures of the private contract (Accounts, AI, API, P3). The Workspace DO does the work. */
import { os, requireWorkspace } from './base';

export const searchHandlers = {
	query: os.search.query.use(requireWorkspace).handler(({ input, context }) => context.workspace.searchQuery(context.actor, input)),
	quick: os.search.quick.use(requireWorkspace).handler(({ input, context }) => context.workspace.searchQuick(context.actor, input)),
	visit: os.search.visit.use(requireWorkspace).handler(async ({ input, context }) => {
		await context.workspace.searchVisit(context.actor, input.id);
		return {};
	})
};
