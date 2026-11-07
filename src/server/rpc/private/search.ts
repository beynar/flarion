/** `search` procedures of the private contract. Owner: Accounts, AI, API (P3/P4). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const searchHandlers = {
	query: os.search.query.handler(() => notImplemented('search.query')),
	quick: os.search.quick.handler(() => notImplemented('search.quick')),
	visit: os.search.visit.handler(() => notImplemented('search.visit')),
};
