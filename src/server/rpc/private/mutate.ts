/** `mutate` procedure of the private contract. Owner: Sync core. The batch is applied by the Workspace DO. */
import { os, requireWorkspaceInObject } from './base';

// The write path of every edit: the role is resolved inside the Workspace DO, in the call that applies the batch.
export const mutateHandler = os.mutate
	.use(requireWorkspaceInObject)
	.handler(({ input, context }) => context.workspace.apply(context.actor, input));
