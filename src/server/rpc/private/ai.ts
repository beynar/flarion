/** `ai` procedures of the private contract. Owner: Accounts, AI, API / Editor (P3/P4). Replace stubs with real handlers. */
import { os, requireWorkspace } from './base';
import { regenerateAiProperty } from '../../ai/property';
import { startWrite } from '../../ai/write';
import { startAsk, type AskWorkspace } from '../../ai/ask';

export const aiHandlers = {
	write: os.ai.write.use(requireWorkspace).handler(({ input, context, signal }) => startWrite(context, input, signal)),
	// Retrieval runs in the Workspace DO (it owns the visibility set); the answer streams from here (`ai/ask.ts`).
	ask: os.ai.ask
		.use(requireWorkspace)
		.handler(({ input, context, signal }) =>
			startAsk({ env: context.env, request: context.request, actor: context.actor, workspace: context.workspace as unknown as AskWorkspace }, input, signal)
		),
	// Recomputes an AI property of a page now (needs `update` on it); `ai/property.ts`.
	regenerate: os.ai.regenerate.use(requireWorkspace).handler(({ input, context }) => regenerateAiProperty(context, input))
};
