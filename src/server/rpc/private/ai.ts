/** `ai` procedures of the private contract. Owner: Accounts, AI, API / Editor (P3/P4). Replace stubs with real handlers. */
import { ORPCError } from '@orpc/server';
import { os, requireWorkspace } from './base';
import { startWrite } from '../../ai/write';

/**
 * Not built until P4 (`ai.regenerate` waits for the AI-property writer and its invalidation markers, `ai.ask` for
 * the retrieval answer stream). A signed-in caller gets a stable code (`NOT_IMPLEMENTED`, HTTP 501) with a message
 * a toast can show as is, and `data.feature` to branch on; nothing is written.
 */
const unavailable = (feature: 'ai-property' | 'ai-ask', what: string): never => {
	throw new ORPCError('NOT_IMPLEMENTED', { message: `${what} are not available yet.`, data: { feature } });
};

export const aiHandlers = {
	write: os.ai.write.use(requireWorkspace).handler(({ input, context, signal }) => startWrite(context, input, signal)),
	ask: os.ai.ask.use(requireWorkspace).handler(() => unavailable('ai-ask', 'Answers drawn from your pages')),
	regenerate: os.ai.regenerate.use(requireWorkspace).handler(() => unavailable('ai-property', 'AI properties'))
};
