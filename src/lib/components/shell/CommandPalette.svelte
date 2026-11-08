<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Command, type CommandGroup, type CommandItem } from 'entasis/command';
	import { Empty } from 'entasis/empty';
	import { Kbd } from 'entasis/kbd';
	import { Spinner } from 'entasis/spinner';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { plusIcon } from 'entasis/icons/plus';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { moonIcon } from 'entasis/icons/moon';
	import { trashIcon } from 'entasis/icons/trash';
	import { gearIcon } from 'entasis/icons/gear';
	import { circleHalfIcon } from 'entasis/icons/circleHalf';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { sparkleIcon } from 'entasis/icons/sparkle';
	import { rpc } from '#lib/client/rpc.ts';
	import { QuickFinder, quickFind, snippetParts, type QuickRow } from '#lib/client/search.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';

	/**
	 * Quick find (`⌘K`, docs/PLAN.md "Search"): `search.quick` orders the rows (title prefixes, then recent visits, then
	 * full-text hits); each row shows its breadcrumb path and, for a text hit, the highlighted snippet. The search is
	 * debounced and keyboard driven (the Command owns arrows, Enter and Escape). Opening a page records the visit in the
	 * store, which tells the server.
	 */
	let {
		open = $bindable(false),
		store,
		ws,
		aiAvailable = true,
		onAction
	}: {
		open?: boolean;
		store: WorkspaceStore;
		ws: string;
		/** Whether the Ask AI action is offered. */
		aiAvailable?: boolean;
		/** Called with the item value for entries that are not plain links. */
		onAction?: (value: string) => void;
	} = $props();

	let search = $state('');
	let rows = $state.raw<QuickRow[]>([]);
	/** The query `rows` answer: the local title matches stand in until the first answer for the typed one. */
	let answered = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);

	const pathOf = (id: string): string[] | undefined => {
		if (!store.page(id)) return undefined;
		return store.ancestors(id).map((entry) => entry.title || 'Untitled');
	};

	const finder = new QuickFinder({
		run: (q) => quickFind(rpc.search, q, pathOf),
		onResult: (q, found) => {
			rows = found;
			answered = q.trim();
			failed = false;
		},
		onState: (value) => (loading = value),
		onError: () => (failed = true)
	});

	$effect(() => {
		if (open) finder.search(search, answered === null);
		else {
			finder.cancel();
			search = '';
			rows = [];
			answered = null;
			failed = false;
		}
		return () => finder.cancel();
	});

	const actions = $derived([
		...(aiAvailable ? [{ value: 'action:ask-ai', label: 'Ask AI', icon: sparkleIcon, shortcut: '⌘J', keywords: ['assistant', 'chat'] }] : []),
		{ value: 'action:new-page', label: 'New page', icon: plusIcon, shortcut: '⌘N', disabled: !store.canEdit },
		{ value: 'action:toggle-sidebar', label: 'Toggle sidebar', icon: sidebarSimpleIcon, shortcut: '⌘\\' },
		{ value: 'action:toggle-dark', label: 'Toggle dark mode', icon: moonIcon, shortcut: '⌘⇧L' },
		{ value: 'action:toggle-contrast', label: 'Toggle high contrast', icon: circleHalfIcon, keywords: ['accessibility'] },
		{ value: 'action:trash', label: 'Open trash', icon: trashIcon, href: `/${ws}/trash` },
		{ value: 'action:settings', label: 'Open settings', icon: gearIcon, href: `/${ws}/settings` }
	]);

	const model = $derived.by((): { groups: CommandGroup[]; lookup: Map<string, QuickRow> } => {
		const q = search.trim();
		const lookup = new Map<string, QuickRow>();
		const toItem = (row: Pick<QuickRow, 'id' | 'title' | 'icon' | 'path'> & Partial<QuickRow>, prefix: string): CommandItem => {
			const value = `${prefix}:${row.id}`;
			lookup.set(value, { source: 'title', ...row } as QuickRow);
			return { value, label: row.title || 'Untitled', icon: fileTextIcon };
		};
		// Nothing is listed until the server has answered for what is typed (or has failed): the Command keeps its
		// highlight on the first row it saw, so a list that grows above it would leave Enter on the wrong row.
		const server = answered === q ? rows : null;
		if (!server && !failed) return { groups: [], lookup };
		const out: CommandGroup[] = [];
		const best = (server ?? []).filter((row) => row.source === 'title');
		const recent = (server ?? []).filter((row) => row.source === 'recent');
		const text = (server ?? []).filter((row) => row.source === 'text');
		if (best.length) out.push({ heading: 'Best matches', items: best.map((row) => toItem(row, 'page')) });
		if (recent.length) out.push({ heading: 'Recent', items: recent.map((row) => toItem(row, 'page')) });
		if (text.length) out.push({ heading: 'In page content', items: text.map((row) => toItem(row, 'page')) });
		const needle = q.toLowerCase();
		const matching = needle ? actions.filter((a) => a.label.toLowerCase().split(' ').some((w) => w.startsWith(needle))) : actions;
		if (matching.length) out.push({ heading: 'Actions', items: matching });
		if (q) {
			out.push({
				heading: undefined,
				items: [{ value: `search:${q}`, label: `Search everything for “${q}”`, icon: magnifyingGlassIcon, shortcut: '⌘↵' }]
			});
		}
		return { groups: out, lookup };
	});

	function onKeydown(event: KeyboardEvent) {
		// ⌘/Ctrl+Enter: open the full search page with what is typed.
		if (open && (event.metaKey || event.ctrlKey) && event.key === 'Enter' && search.trim()) {
			event.preventDefault();
			event.stopPropagation();
			onAction?.(`search:${search.trim()}`);
			open = false;
		}
	}
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#snippet iconOf(item: CommandItem, row: QuickRow | undefined)}
	<span class="flex size-5 shrink-0 items-center justify-center text-base leading-none text-[color:var(--app-text-secondary)]" aria-hidden="true">
		{#if row?.icon}
			{row.icon}
		{:else if item.icon && typeof item.icon !== 'string'}
			{@render (item.icon as Snippet<[{ size?: number }]>)({ size: 16 })}
		{/if}
	</span>
{/snippet}

{#snippet row(item: CommandItem)}
	{@const info = model.lookup.get(item.value)}
	<span class="flex min-w-0 flex-1 items-start gap-2.5" data-testid="quick-row" data-source={info?.source ?? 'action'}>
		{@render iconOf(item, info)}
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="flex min-w-0 items-baseline gap-2">
				<span class="truncate">{item.label}</span>
				{#if info && info.path.length > 0}
					<span class="min-w-0 truncate text-xs text-[color:var(--app-text-secondary)]" data-testid="quick-path">{info.path.join(' / ')}</span>
				{/if}
			</span>
			{#if info?.snippet}
				<span class="line-clamp-2 text-xs text-[color:var(--app-text-secondary)]" data-testid="quick-snippet">
					{#each snippetParts(info.snippet) as part, index (index)}{#if part.mark}<mark class="rounded-[2px] bg-[color:var(--app-block-yellow-bg)] px-px text-inherit">{part.text}</mark>{:else}{part.text}{/if}{/each}
				</span>
			{/if}
		</span>
		{#if item.shortcut}
			<span class="shrink-0 text-xs text-[color:var(--app-text-tertiary)]">{item.shortcut}</span>
		{/if}
	</span>
{/snippet}

<!-- ⌘K is handled by the Command itself (`shortcut`). -->
<Command
	dialog
	shortcut="k"
	title="Quick find"
	bind:open
	bind:search
	items={model.groups}
	item={row}
	shouldFilter={false}
	autoHighlight="always"
	placeholder="Search pages and actions…"
	onSelect={(value) => onAction?.(value)}
>
	{#snippet empty()}
		{#if loading}
			<div class="flex items-center justify-center gap-2 py-6 text-sm text-[color:var(--app-text-secondary)]" role="status">
				<Spinner size="small" /> Searching…
			</div>
		{:else if failed}
			<Empty size="small" title="Search is unavailable" description="Check your connection and try again." />
		{:else}
			<Empty size="small" title={`No pages match “${search}”`} />
		{/if}
	{/snippet}
	{#snippet footer()}
		<div
			class="flex items-center gap-4 border-t border-[color:var(--app-hairline)] px-3 py-2 text-xs text-[color:var(--app-text-secondary)]"
		>
			<span class="inline-flex items-center gap-1.5"><Kbd size="small" keys={['↑', '↓']} /> Navigate</span>
			<span class="inline-flex items-center gap-1.5"><Kbd size="small" keys={['↵']} /> Open</span>
			<span class="inline-flex items-center gap-1.5"><Kbd size="small" keys={['Esc']} /> Close</span>
			{#if loading}<span class="ml-auto inline-flex items-center gap-1.5" role="status"><Spinner size="small" /> Searching…</span>{/if}
		</div>
	{/snippet}
</Command>
