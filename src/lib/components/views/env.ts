/**
 * What a view layout (table, board, list, gallery, calendar, timeline) receives from the host: the definitions,
 * the lookups cells need and the writes they call. The layouts never touch the store's windows themselves.
 */
import type { PageEntity, WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import type { CollectionDef, ViewDef } from '#lib/shared/definitions.ts';
import type { FilterGroup } from '#lib/shared/filter-ast.ts';
import type { PropValue, PropertyDef } from '#lib/shared/property-types.ts';
import type { Values, ViewRow } from '#lib/shared/protocol.ts';
import type { PropertyEditorCallbacks, PropertyLookups } from '#lib/components/properties/types.ts';
import type { ColumnSpec } from './view-model.ts';

export interface ViewEnv {
	store: WorkspaceStore;
	workspaceId: string;
	collection: CollectionDef;
	view: ViewDef;
	/** Visible columns, the title first. */
	columns: ColumnSpec[];
	/** The whole registry (cards pick their own). */
	properties: PropertyDef[];
	/** The viewer may edit rows (not read-only, online, `update` access on the database). */
	editable: boolean;
	/** The `database_view` block's local filter. */
	localFilter: FilterGroup | null;
	/** True on a database's own page (the layouts take the room). */
	fullPage: boolean;
	lookups: PropertyLookups;
	/** The editing callbacks of one row's cell. */
	actions(rowId: string, def: PropertyDef): PropertyEditorCallbacks;
	href(pageId: string): string;
	open(pageId: string, event?: MouseEvent | KeyboardEvent): void;
	setTitle(rowId: string, title: string): void;
	setValue(rowId: string, prop: string, value: PropValue | null): Promise<unknown>;
	/** Creates a row from the view (values that satisfy its filter, plus `extra`); resolves with its id. */
	newRow(extra?: Values, opts?: { open?: boolean }): Promise<string | null>;
	/** Persists a change of the view's definition. */
	updateView(patch: Partial<Pick<ViewDef, 'name' | 'type' | 'filter' | 'sorts' | 'groupBy' | 'columns'>>): Promise<void>;
	/** Writes one view option (card size, date property...). */
	setOption(patch: Record<string, unknown>): Promise<void>;
	/** Puts a row before or after another in the view's manual order. */
	moveRow(rowId: string, place: { before?: string | null; after?: string | null }): Promise<void>;
	/** The view has no sort, so rows can be dragged into place. */
	manualOrder: boolean;
	/** Grows the window: all of it, or one group's. */
	loadMore(group?: string): void;
	/** The entity behind a row, when the store has it (cover and rank come from there). */
	entity(rowId: string): PageEntity | undefined;
	/** Cover of a row for a card: the files property or the page cover, as a CSS background; null without one. */
	cover(row: ViewRow): { image: string; isImage: boolean } | null;
}
