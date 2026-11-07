<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Button } from 'entasis/button';
	import { trashIcon } from 'entasis/icons/trash';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { filterKey, type FilterGroup } from '#lib/shared/filter-ast.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import type { BuilderApi } from './api.ts';
	import FilterGroupView from './FilterGroupView.svelte';
	import { countConditions, filterableProps, pruneFilter, registryOf } from './logic.ts';

	/**
	 * The nested filter builder (AND/OR groups up to three levels). It edits a working draft, where a
	 * condition may still lack its value, and calls `onChange` only with the pruned AST the engine accepts
	 * (`validateFilter` passes): incomplete conditions and empty groups are left out. Typing is committed after a
	 * short pause, every other edit at once.
	 */
	let {
		filter,
		properties,
		store,
		readonly = false,
		onChange
	}: {
		filter: FilterGroup;
		properties: PropertyDef[];
		store: WorkspaceStore;
		readonly?: boolean;
		onChange: (filter: FilterGroup) => void;
	} = $props();

	const TYPING_MS = 300;

	let draft = $state.raw<FilterGroup>(untrack(() => filter));
	const registry = $derived(registryOf(properties));
	const filterable = $derived(filterableProps(properties.some((p) => p.type === 'title') ? properties : [registry.get('title')!, ...properties]));

	let timer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let sent = filterKey(untrack(() => pruneFilter(filter, registry)));

	function flush() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (!dirty) return;
		dirty = false;
		const out = pruneFilter(draft, registry);
		const key = filterKey(out);
		if (key === sent) return;
		sent = key;
		onChange(out);
	}

	const edit: BuilderApi['edit'] = (fn, typing = false) => {
		if (readonly) return;
		draft = fn(draft);
		dirty = true;
		if (timer) clearTimeout(timer);
		timer = null;
		if (typing) timer = setTimeout(flush, TYPING_MS);
		else flush();
	};

	// Another client (or a view switch) changed the filter: show it, unless it is what this draft already says.
	$effect(() => {
		const incoming = filter;
		untrack(() => {
			if (dirty) return;
			const key = filterKey(pruneFilter(incoming, registry));
			if (key !== filterKey(pruneFilter(draft, registry))) draft = incoming;
			sent = key;
		});
	});

	onDestroy(flush);

	const api: BuilderApi = {
		get store() {
			return store;
		},
		get readonly() {
			return readonly;
		},
		get registry() {
			return registry;
		},
		get filterable() {
			return filterable;
		},
		get members() {
			return store.members;
		},
		edit
	};

	const count = $derived(countConditions(draft));
</script>

<div class="flex min-w-[540px] flex-col gap-2 p-3" data-testid="filter-builder">
	{#if count === 0}
		<p class="px-0.5 text-sm text-[color:var(--app-text-tertiary)]" data-testid="filter-empty">No filters applied. Add a rule to narrow this view.</p>
	{/if}
	<FilterGroupView group={draft} path={[]} {api} />
	{#if count > 0 && !readonly}
		<div class="border-t border-[color:var(--app-hairline)] pt-1.5">
			<Button variant="ghost" size="small" color="danger" prefix={trashIcon} data-testid="filter-clear" onclick={() => edit(() => ({ and: [] }))}>Delete filter</Button>
		</div>
	{/if}
</div>
