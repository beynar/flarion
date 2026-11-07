/**
 * Private API router (`/rpc`). Assembles each owner's handler file; do not put handlers here.
 */
import { os } from './base';
import { meHandler } from './me';
import { workspaceHandlers } from './workspace';
import { teamspacesHandlers } from './teamspaces';
import { pageHandlers } from './page';
import { propertyHandlers } from './property';
import { collectionHandlers } from './collection';
import { viewHandlers } from './view';
import { mutateHandler } from './mutate';
import { searchHandlers } from './search';
import { aiHandlers } from './ai';
import { filesHandlers } from './files';
import { tokensHandlers } from './tokens';

export const router = os.router({
	me: meHandler,
	workspace: { ...workspaceHandlers, teamspaces: teamspacesHandlers },
	page: pageHandlers,
	property: propertyHandlers,
	collection: collectionHandlers,
	view: viewHandlers,
	mutate: mutateHandler,
	search: searchHandlers,
	ai: aiHandlers,
	files: filesHandlers,
	tokens: tokensHandlers
});

export type PrivateRouter = typeof router;
