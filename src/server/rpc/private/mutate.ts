/** `mutate` procedure of the private contract. Owner: Sync core. The batch is applied by the Workspace DO. */
import { os, requireWorkspace } from './base';

export const mutateHandler = os.mutate
	.use(requireWorkspace)
	.handler(({ input, context }) => context.workspace.apply(context.actor, input));
