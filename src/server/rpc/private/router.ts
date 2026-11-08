/**
 * Private API router (`/rpc`). Assembles each owner's handler file; do not put handlers here.
 */
import { os } from './base';
import { meHandler } from './me';
import { accountHandlers } from './account';
import { adminHandlers } from './admin';
import { workspaceHandlers } from './workspace';
import { teamspacesHandlers } from './teamspaces';
import { pageHandlers } from './page';
import { pageLockHandlers } from './page-lock';
import { propertyHandlers } from './property';
import { collectionHandlers } from './collection';
import { viewHandlers } from './view';
import { mutateHandler } from './mutate';
import { searchHandlers } from './search';
import { aiHandlers } from './ai';
import { filesHandlers } from './files';
import { importHandlers } from './import';
import { tokensHandlers } from './tokens';
import { exportHandlers } from './export';

export const router = os.router({
	me: meHandler,
	account: accountHandlers,
	admin: adminHandlers,
	workspace: { ...workspaceHandlers, teamspaces: teamspacesHandlers, export: exportHandlers.workspace },
	page: { ...pageHandlers, lock: pageLockHandlers, export: exportHandlers.page, exportStatus: exportHandlers.status },
	property: propertyHandlers,
	collection: collectionHandlers,
	view: viewHandlers,
	mutate: mutateHandler,
	search: searchHandlers,
	ai: aiHandlers,
	files: filesHandlers,
	import: importHandlers,
	tokens: tokensHandlers
});

export type PrivateRouter = typeof router;
