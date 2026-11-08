/** `import` procedures of the private contract (docs/PLAN.md "Databases: Imports"). Owner: Databases. See `server/import/start.ts`. */
import { APP_VERSION_HEADER } from '../../../lib/shared/protocol';
import { beginImport, cancelImport, importStatus, type ImportHost } from '../../import/start';
import { os, requireWorkspace, type WorkspaceContext } from './base';

const hostOf = (context: WorkspaceContext) => context.workspace as unknown as ImportHost;

export const importHandlers = {
	begin: os.import.begin.use(requireWorkspace).handler(({ input, context }) =>
		beginImport(
			{
				env: context.env,
				ctx: context.ctx,
				workspace: hostOf(context),
				actor: context.actor,
				appVersion: context.request.headers.get(APP_VERSION_HEADER) ?? context.env.APP_VERSION ?? '0.0.0'
			},
			input
		)
	),
	status: os.import.status.use(requireWorkspace).handler(({ input, context }) => importStatus(hostOf(context), context.actor, input.id)),
	cancel: os.import.cancel.use(requireWorkspace).handler(({ input, context }) => cancelImport(context.env, hostOf(context), context.actor, input.id))
};
