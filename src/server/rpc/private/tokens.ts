/** `tokens` procedures of the private contract. Owner: Accounts, AI, API (P4). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const tokensHandlers = {
	list: os.tokens.list.handler(() => notImplemented('tokens.list')),
	create: os.tokens.create.handler(() => notImplemented('tokens.create')),
	revoke: os.tokens.revoke.handler(() => notImplemented('tokens.revoke')),
};
