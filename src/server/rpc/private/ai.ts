/** `ai` procedures of the private contract. Owner: Accounts, AI, API / Editor (P3/P4). Replace stubs with real handlers. */
import { notImplemented, os, requireWorkspace } from './base';
import { startWrite } from '../../ai/write';

export const aiHandlers = {
	write: os.ai.write.use(requireWorkspace).handler(({ input, context, signal }) => startWrite(context, input, signal)),
	ask: os.ai.ask.handler(() => notImplemented('ai.ask')),
	regenerate: os.ai.regenerate.handler(() => notImplemented('ai.regenerate')),
};
