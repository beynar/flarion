<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page as route } from '$app/state';
	import { Alert } from 'entasis/alert';
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Combobox, type ComboboxOption } from 'entasis/combobox';
	import { DateInput } from 'entasis/date-input';
	import { Empty } from 'entasis/empty';
	import { MenuOption } from 'entasis/menu-option';
	import { Popover } from 'entasis/popover';
	import { SegmentedControl } from 'entasis/segmented-control';
	import { Select } from 'entasis/select';
	import { Skeleton } from 'entasis/skeleton';
	import { TextInput } from 'entasis/text-input';
	import { folderIcon } from 'entasis/icons/folder';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { xIcon } from 'entasis/icons/x';
	import { rpc } from '#lib/client/rpc.ts';
	import {
		filtersFromParams,
		filtersToParams,
		relativeTime,
		snippetParts,
		toQueryInput,
		type EditedPreset,
		type SearchFilters,
		type SearchSort
	} from '#lib/client/search.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import PagePicker from '#lib/components/pickers/PagePicker.svelte';
	import { calendarDate, toDateOnly } from '#lib/components/properties/helpers.ts';
	import type { SearchHit } from './types.ts';

	/**
	 * The search page (`/[ws]/search`, docs/PLAN.md "Search"): `search.query` with highlighted snippets, filters for
	 * creator (a Combobox of members), last edited (presets or a DateInput range) and location (a page picker), a sort
	 * and cursor paging. The state lives in the URL, so a search can be shared and survives a reload.
	 */
	let { store, ws, initial = null }: { store: WorkspaceStore; ws: string; initial?: { hits: SearchHit[]; nextCursor: string | null } | null } = $props();

	const PAGE_SIZE = 20;
	let filters = $state<SearchFilters>(untrack(() => filtersFromParams(route.url.searchParams)));
	let typed = $state(untrack(() => filters.q));
	// The server render ran the search the URL names: its results are on screen from the first paint and are not asked for again.
	let hits = $state.raw<SearchHit[]>(untrack(() => initial?.hits ?? []));
	let cursor = $state<string | null>(untrack(() => initial?.nextCursor ?? null));
	let status = $state<'idle' | 'loading' | 'more' | 'ready' | 'error'>(untrack(() => (initial ? 'ready' : 'idle')));
	let errorText = $state('');
	let serial = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let locationOpen = $state(false);

	const searchable = $derived(filters.q.trim().length > 0);

	async function run(more = false) {
		if (!searchable) {
			hits = [];
			cursor = null;
			status = 'idle';
			return;
		}
		const mine = ++serial;
		status = more ? 'more' : 'loading';
		try {
			const result = await rpc.search.query({
				...toQueryInput(filters),
				limit: PAGE_SIZE,
				...(more && cursor ? { cursor } : {})
			});
			if (mine !== serial) return;
			hits = more ? [...hits, ...result.hits] : result.hits;
			cursor = result.nextCursor;
			status = 'ready';
		} catch (error) {
			if (mine !== serial) return;
			errorText = error instanceof Error ? error.message : 'Search failed';
			status = 'error';
		}
	}

	/** Keeps the URL in step with the filters (replacing the history entry) and runs the search. */
	function commit(next: SearchFilters, wait = 0) {
		filters = next;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const params = filtersToParams(filters).toString();
			void goto(`/${ws}/search${params ? `?${params}` : ''}`, { replace: true, reset: false });
			void run();
		}, wait);
	}
	const patch = (change: Partial<SearchFilters>, wait = 0) => commit({ ...filters, ...change }, wait);

	onMount(() => {
		if (!initial) void run();
	});
	onDestroy(() => clearTimeout(timer));

	// Landing here again from ⌘K ("Search everything for …") changes `q` while this page stays mounted.
	$effect(() => {
		const incoming = route.url.searchParams.get('q') ?? '';
		untrack(() => {
			if (incoming !== filters.q) {
				typed = incoming;
				filters = filtersFromParams(route.url.searchParams);
				void run();
			}
		});
	});

	// ── creator ──
	const creatorItems = $derived<ComboboxOption[]>([
		{ value: '', label: 'Anyone' },
		...store.members.map((m) => ({ value: m.userId, label: m.name, description: m.email, data: { image: m.image } }))
	]);
	let creatorSearch = $state('');
	const creator = $derived(store.members.find((m) => m.userId === filters.createdBy));

	// ── last edited ──
	const editedItems: { value: EditedPreset; label: string }[] = [
		{ value: 'any', label: 'Any time' },
		{ value: 'day', label: 'Past 24 hours' },
		{ value: 'week', label: 'Past week' },
		{ value: 'month', label: 'Past month' },
		{ value: 'year', label: 'Past year' },
		{ value: 'custom', label: 'Custom range…' }
	];

	const sortItems: { value: SearchSort; label: string }[] = [
		{ value: 'relevance', label: 'Relevance' },
		{ value: 'edited_desc', label: 'Newest' },
		{ value: 'edited_asc', label: 'Oldest' }
	];

	const location = $derived(filters.under ? store.resolvePage(filters.under) : null);

	const dateChange = (key: 'from' | 'to') => (date: Date | null) => patch({ [key]: date ? toDateOnly(date) : null } as Partial<SearchFilters>);
	const anyFilter = $derived(!!filters.createdBy || filters.edited !== 'any' || !!filters.under);
	const reset = () => patch({ createdBy: null, edited: 'any', from: null, to: null, under: null });
</script>

{#snippet creatorOption(option: ComboboxOption)}
	<span class="flex min-w-0 items-center gap-2">
		{#if option.value}<Avatar size="small" name={option.label} src={(option.data?.image as string | null) ?? undefined} />{/if}
		<span class="truncate">{option.label}</span>
		{#if option.description}<span class="ml-auto shrink-0 truncate pl-2 text-xs text-[color:var(--app-text-secondary)]">{option.description}</span>{/if}
	</span>
{/snippet}

<div class="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 pt-8 pb-24 md:px-10" data-testid="search-page">
	<h1 class="m-0 text-2xl font-bold text-[color:var(--app-text)]">Search</h1>

	<form
		role="search"
		class="contents"
		onsubmit={(event) => {
			event.preventDefault();
			patch({ q: typed }, 0);
		}}
	>
		<TextInput
			label="Search pages and content"
			theme={{ label: { base: 'sr-only' } }}
			placeholder="Search pages and content…"
			bind:value={typed}
			onValueChange={(value) => patch({ q: value ?? '' }, 250)}
			inputAttrs={{ 'data-testid': 'search-input', autocomplete: 'off', enterkeyhint: 'search' }}
		>
			{#snippet prefix()}{@render magnifyingGlassIcon({ size: 16 })}{/snippet}
		</TextInput>
	</form>

	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filters" data-testid="search-filters">
		<div class="w-44" data-testid="search-filter-creator">
			<Combobox
				size="small"
				label="Created by"
				theme={{ label: { base: 'sr-only' } }}
				placeholder={creator ? creator.name : 'Created by: anyone'}
				prefix={false}
				bind:searchValue={creatorSearch}
				value={filters.createdBy ?? ''}
				items={creatorItems}
				item={creatorOption}
				noOptionsText="No member matches"
				onValueChange={({ value }) => {
					creatorSearch = '';
					patch({ createdBy: value || null });
				}}
			/>
		</div>

		<div class="w-40" data-testid="search-filter-edited">
			<Select
				size="small"
				label="Last edited"
				theme={{ label: { base: 'sr-only' } }}
				items={editedItems}
				value={filters.edited}
				alignItemWithTrigger={false}
				triggerAttrs={{ 'aria-label': 'Last edited' }}
				onValueChange={(value) => value && patch({ edited: value as EditedPreset, ...(value === 'custom' ? {} : { from: null, to: null }) })}
			/>
		</div>
		{#if filters.edited === 'custom'}
			<span class="inline-flex items-center gap-1" data-testid="search-filter-range">
				<DateInput
					size="small"
					class="w-36"
					label="Edited from"
					theme={{ label: { base: 'sr-only' } }}
					format="yyyy/mm/dd"
					closeOnSelect
					value={filters.from ? calendarDate(filters.from) : null}
					onValueChange={dateChange('from')}
				/>
				<span class="text-sm text-[color:var(--app-text-secondary)]">to</span>
				<DateInput
					size="small"
					class="w-36"
					label="Edited to"
					theme={{ label: { base: 'sr-only' } }}
					format="yyyy/mm/dd"
					closeOnSelect
					value={filters.to ? calendarDate(filters.to) : null}
					onValueChange={dateChange('to')}
				/>
			</span>
		{/if}

		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open={locationOpen} offset={4}>
			{#snippet trigger(popover)}
				<Button variant="outline" size="small" class="max-w-[240px] justify-start font-normal" haspopup="dialog" data-testid="search-filter-location" {@attach popover.trigger}>
					{#snippet prefix()}{@render folderIcon({ size: 14 })}{/snippet}
					<span class="truncate">{location ? `In: ${location.icon ?? ''} ${location.title}`.replace('  ', ' ') : 'Anywhere'}</span>
				</Button>
			{/snippet}
			{#snippet children(popover)}
				<div class="w-[320px]" data-testid="search-location-picker">
					<PagePicker
						{store}
						heading="Search inside a page"
						placeholder="Search for a page…"
						onpick={(id) => {
							patch({ under: id });
							popover.close();
						}}
					/>
				</div>
			{/snippet}
		</Popover>
		{#if filters.under}
			<Button variant="ghost" size="small" label="Clear location" onclick={() => patch({ under: null })} data-testid="search-clear-location">
				{#snippet prefix()}{@render xIcon({ size: 14 })}{/snippet}
			</Button>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			{#if anyFilter}
				<Button variant="ghost" size="small" onclick={reset} data-testid="search-reset">Clear filters</Button>
			{/if}
			<SegmentedControl
				size="small"
				label="Sort by"
				items={sortItems}
				value={filters.sort}
				onValueChange={(value) => value && patch({ sort: value as SearchSort })}
			/>
		</div>
	</div>

	<div aria-live="polite" class="min-h-5 text-xs text-[color:var(--app-text-secondary)]" data-testid="search-status">
		{#if status === 'loading'}
			Searching…
		{:else if status === 'ready' || status === 'more'}
			{hits.length}{cursor ? '+' : ''} {hits.length === 1 && !cursor ? 'result' : 'results'}
		{/if}
	</div>

	{#if status === 'error'}
		<Alert color="danger" variant="soft" size="small">
			<span class="flex items-center gap-2">
				<span>Search failed: {errorText}</span>
				<Button size="small" variant="outline" onclick={() => run()}>Try again</Button>
			</span>
		</Alert>
	{:else if !searchable}
		<Empty title="Search your workspace" description="Type to find pages by title or content. Only pages you can open are shown." />
	{:else if status === 'loading' && hits.length === 0}
		<div class="flex flex-col gap-3" role="status" aria-label="Loading results">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton class="h-12 w-full" />
			{/each}
		</div>
	{:else if status !== 'loading' && hits.length === 0}
		<Empty title={`No results for “${filters.q.trim()}”`} description={anyFilter ? 'Try removing a filter.' : 'Check the spelling or try other words.'}>
			{#if anyFilter}<Button variant="outline" size="small" onclick={reset}>Clear filters</Button>{/if}
		</Empty>
	{:else}
		<ul class="m-0 flex list-none flex-col p-0" data-testid="search-results" aria-label="Search results">
			{#each hits as hit (hit.id)}
				<li class="contents">
					<MenuOption as="a" href={`/${ws}/${hit.id}`} class="h-auto min-h-[var(--app-row-height)] items-start py-2" attrs={{ 'data-testid': 'search-hit', 'data-hit': hit.id }}>
						{#snippet prefix()}
							<span class="mt-0.5 flex size-5 items-center justify-center text-base leading-none" aria-hidden="true">{hit.icon ?? '📄'}</span>
						{/snippet}
						{#snippet children()}
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="flex min-w-0 items-baseline gap-2">
									<span class="truncate font-medium" data-testid="search-hit-title">
										{#if hit.field === 'title'}{#each snippetParts(hit.snippet) as part, i (i)}{#if part.mark}<mark class="rounded-[2px] bg-[color:var(--app-block-yellow-bg)] px-px text-inherit">{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{hit.title || 'Untitled'}{/if}
									</span>
									{#if hit.path.length}
										<span class="min-w-0 truncate text-xs text-[color:var(--app-text-secondary)]" data-testid="search-hit-path">{hit.path.join(' / ')}</span>
									{/if}
								</span>
								{#if hit.field !== 'title'}
									<span class="line-clamp-2 text-sm text-[color:var(--app-text-secondary)]" data-testid="search-hit-snippet">
										{#each snippetParts(hit.snippet) as part, i (i)}{#if part.mark}<mark class="rounded-[2px] bg-[color:var(--app-block-yellow-bg)] px-px text-inherit">{part.text}</mark>{:else}{part.text}{/if}{/each}
									</span>
								{/if}
								<span class="text-xs text-[color:var(--app-text-secondary)]">Edited {relativeTime(hit.updatedAt)}</span>
							</span>
						{/snippet}
					</MenuOption>
				</li>
			{/each}
		</ul>
		{#if cursor}
			<div class="flex justify-center">
				<Button variant="outline" size="small" loading={status === 'more'} onclick={() => run(true)} data-testid="search-more">Load more results</Button>
			</div>
		{/if}
	{/if}
</div>
