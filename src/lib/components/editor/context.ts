/**
 * What the custom blocks (database view, breadcrumb, date mention) need from the page around the editor. The
 * editor view builds one and both passes it to the plugin list (commands close over it) and publishes it with
 * Svelte context, so the components the block snippets render can read it (`getEditorContext`).
 */
import { getContext, setContext } from 'svelte';

export interface AncestorRef {
	id: string;
	title: string;
	icon: string | null;
}

export interface DatabaseRef {
	id: string;
	title: string;
	icon: string | null;
}

export interface EditorContext {
	workspaceId: string;
	pageId: string;
	/** The pages above `pageId`, root first, ending with its parent (reactive in the App UI store). */
	resolveAncestors?: (pageId: string) => AncestorRef[];
	/** A page's current title and icon. */
	resolvePage?: (pageId: string) => { title: string; icon: string | null } | undefined;
	/** Databases whose title matches `query` (the linked view's picker). */
	searchDatabases?: (query: string) => DatabaseRef[] | Promise<DatabaseRef[]>;
	/** Opens a page (a database's title, a breadcrumb item). */
	open?: (pageId: string, how: { newTab: boolean }) => void;
	href: (pageId: string) => string;
	/** Whether the view may change the page (a locked or read-only page shows its blocks but changes none). */
	readonly: () => boolean;
}

const KEY = Symbol('flarion.editor.context');

export const setEditorContext = (context: EditorContext) => setContext(KEY, context);

export function getEditorContext(): EditorContext | undefined {
	return getContext<EditorContext | undefined>(KEY);
}
