/** Public API router (`/v1`): assembles each resource's handlers. The contract is `publicContract`. */
import { pub } from './base';
import { blocksHandlers } from './blocks';
import { commentsHandlers } from './comments';
import { databasesHandlers } from './databases';
import { pagesHandlers } from './pages';
import { searchHandler } from './search';
import { usersHandlers } from './users';

export const publicRouter = pub.router({
	pages: pagesHandlers,
	blocks: blocksHandlers,
	databases: databasesHandlers,
	search: searchHandler,
	comments: commentsHandlers,
	users: usersHandlers
});

export type PublicRouter = typeof publicRouter;
