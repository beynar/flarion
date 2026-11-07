/** `ai` procedures of the private contract. Owner: Accounts, AI, API / Editor (P3/P4). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const aiHandlers = {
	write: os.ai.write.handler(() => notImplemented('ai.write')),
	ask: os.ai.ask.handler(() => notImplemented('ai.ask')),
	regenerate: os.ai.regenerate.handler(() => notImplemented('ai.regenerate')),
};
