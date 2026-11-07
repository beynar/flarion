import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import type { FilterGroup } from '#lib/shared/filter-ast.ts';
import type { PropertyDef, PropertyRegistry } from '#lib/shared/property-types.ts';
import type { Member } from '#lib/shared/schemas.ts';

/** What the recursive group and condition views of the builder share. */
export interface BuilderApi {
	store: WorkspaceStore;
	readonly: boolean;
	registry: PropertyRegistry;
	/** The properties a condition may pick. */
	filterable: PropertyDef[];
	members: readonly Member[];
	/** Rewrites the draft tree. `typing` edits are committed after a pause, the others at once. */
	edit: (fn: (root: FilterGroup) => FilterGroup, typing?: boolean) => void;
}
