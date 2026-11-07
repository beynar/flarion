<!--
	The toolbar of a view: filter, sort, group (boards), properties, layout, a search-in-view box and the "New"
	button. Each opens a popover over the editors; edits go to `env.updateView` and show at once.
-->
<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
	import { funnelSimpleIcon } from 'entasis/icons/funnelSimple';
	import { arrowsDownUpIcon } from 'entasis/icons/arrowsDownUp';
	import { rowsIcon } from 'entasis/icons/rows';
	import { slidersHorizontalIcon } from 'entasis/icons/slidersHorizontal';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { gearSixIcon } from 'entasis/icons/gearSix';
	import { FilterBuilder, SortEditor, GroupEditor, countConditions } from '#lib/components/filters/index.ts';
	import { dateProps, GROUPED_TYPES } from './view-model.ts';
	import type { ViewEnv } from './env.ts';
	import LayoutMenu from './LayoutMenu.svelte';
	import PropertiesMenu from './PropertiesMenu.svelte';

	let { env, search = $bindable('') }: { env: ViewEnv; search: string } = $props();

	const filterCount = $derived(countConditions(env.view.filter));
	const sortCount = $derived(env.view.sorts.length);
	const grouped = $derived(GROUPED_TYPES.has(env.view.type));
	let searchOpen = $state(false);
	const showSearch = $derived(searchOpen || search !== '');

	const accent = 'text-[color:var(--app-accent)]';

	function create() {
		const dp = dateProps(env.view, env.properties);
		const today = new Date().toISOString().slice(0, 10);
		const extra = (env.view.type === 'calendar' || env.view.type === 'timeline') && dp.start ? { [dp.start.id]: { start: today } } : {};
		void env.newRow(extra);
	}
</script>

<div class="toolbar" data-testid="view-toolbar">
	<Popover position="bottom-end" modal={false} offset={4} focusOnOpen="first" class="max-w-[640px]">
		{#snippet trigger(popover)}
			<Button variant="ghost" size="small" prefix={funnelSimpleIcon} data-testid="view-filter" class={filterCount ? accent : ''} {@attach popover.trigger}>
				{filterCount ? `${filterCount} ${filterCount === 1 ? 'filter' : 'filters'}` : 'Filter'}
			</Button>
		{/snippet}
		{#snippet children()}
			<FilterBuilder
				filter={env.view.filter}
				properties={env.properties}
				store={env.store}
				readonly={!env.editable}
				onChange={(filter) => void env.updateView({ filter }).catch(() => undefined)}
			/>
		{/snippet}
	</Popover>

	<Popover position="bottom-end" modal={false} offset={4} focusOnOpen="first" class="max-w-[640px]">
		{#snippet trigger(popover)}
			<Button variant="ghost" size="small" prefix={arrowsDownUpIcon} data-testid="view-sort" class={sortCount ? accent : ''} {@attach popover.trigger}>
				{sortCount ? `${sortCount} ${sortCount === 1 ? 'sort' : 'sorts'}` : 'Sort'}
			</Button>
		{/snippet}
		{#snippet children()}
			<SortEditor sorts={env.view.sorts} properties={env.properties} readonly={!env.editable} onChange={(sorts) => void env.updateView({ sorts }).catch(() => undefined)} />
		{/snippet}
	</Popover>

	{#if grouped}
		<Popover position="bottom-end" modal={false} offset={4} focusOnOpen="first" class="max-w-[640px]">
			{#snippet trigger(popover)}
				<Button variant="ghost" size="small" prefix={rowsIcon} data-testid="view-group" class={env.view.groupBy ? accent : ''} {@attach popover.trigger}>Group</Button>
			{/snippet}
			{#snippet children()}
				<GroupEditor groupBy={env.view.groupBy} properties={env.properties} members={env.lookups.members} readonly={!env.editable} onChange={(groupBy) => void env.updateView({ groupBy }).catch(() => undefined)} />
			{/snippet}
		</Popover>
	{/if}

	<Popover position="bottom-end" modal={false} offset={4} focusOnOpen="first" class="max-w-[640px]">
		{#snippet trigger(popover)}
			<Button variant="ghost" size="small" prefix={slidersHorizontalIcon} data-testid="view-properties" {@attach popover.trigger}>Properties</Button>
		{/snippet}
		{#snippet children()}
			<PropertiesMenu {env} />
		{/snippet}
	</Popover>

	<Popover position="bottom-end" modal={false} offset={4} focusOnOpen="first" class="max-w-[640px]">
		{#snippet trigger(popover)}
			<Button variant="ghost" size="small" label="Layout" prefix={gearSixIcon} data-testid="view-layout" {@attach popover.trigger} />
		{/snippet}
		{#snippet children()}
			<LayoutMenu {env} />
		{/snippet}
	</Popover>

	{#if showSearch}
		<div class="w-44" {@attach (el) => el.querySelector('input')?.focus()}>
			<TextInput
				size="small"
				placeholder="Search…"
				prefix={magnifyingGlassIcon}
				value={search}
				onValueChange={(v) => (search = v ?? '')}
				inputAttrs={{
					'aria-label': 'Search in this view',
					'data-testid': 'view-search',
					onblur: () => setTimeout(() => (searchOpen = search !== ''), 250)
				}}
			/>
		</div>
	{:else}
		<Button variant="ghost" size="small" label="Search in this view" prefix={magnifyingGlassIcon} data-testid="view-search-toggle" onclick={() => (searchOpen = true)} />
	{/if}

	{#if env.editable}
		<Button size="small" data-testid="view-new" onclick={create}>New</Button>
	{/if}
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}
</style>
