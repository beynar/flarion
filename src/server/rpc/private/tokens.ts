/**
 * `tokens` procedures of the private contract: a member manages their own API tokens for the workspace they are in
 * (`auth/api-tokens.ts`). A token acts as its creator, with their access in that workspace, narrowed by its scopes.
 */
import { os, requireWorkspace } from './base';
import { createToken, listTokens, revokeToken } from '../../auth/api-tokens';

export const tokensHandlers = {
	list: os.tokens.list.use(requireWorkspace).handler(({ context }) => listTokens(context.env, context.actor.workspaceId, context.actor.userId)),
	create: os.tokens.create.use(requireWorkspace).handler(({ context, input }) => createToken(context.env, context.actor, input)),
	revoke: os.tokens.revoke.use(requireWorkspace).handler(async ({ context, input }) => {
		await revokeToken(context.env, context.actor, input.id);
		return {};
	})
};
