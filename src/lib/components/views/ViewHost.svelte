<!--
	The live view of a database: the host of the table, board, list, gallery, calendar and timeline layouts. It
	replaces the P2 polling table and keeps its props, so the editor's `database_view` block and a database's own
	page both render it.

	  workspaceId   the workspace the collection lives in
	  collectionId  the collection to show
	  viewId        a view of it, or null for its first view
	  localFilter   an extra filter ANDed with the view's, local to the block (null for none)
	  readonly      the viewer may not change rows or the view
	  href          where a row's page lives (default `/<workspaceId>/<pageId>`)
	  onViewChange  the active view changed (a block stores it); without it the host keeps the choice itself
	  fullPage      the database's own page: the layouts take the room

	The host subscribes to the view through the workspace store (a `view` subscription: a snapshot, then diffs
	applied in `seq` order, windows per view or per board column), picks the layout of the view's type, and owns the
	tab bar and the toolbar (filter, sort, group, properties, layout, search, New). Definition edits go through the
	store (`updateView`) and show at once.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'entasis/toast';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Skeleton } from 'entasis/skeleton';
	import { goto } from '$app/navigation';
	import { subKey, tryWorkspace, type ViewData } from '#lib/client/workspace.svelte.ts';
	import { newId } from '#lib/client/runtime.ts';
	import { fileCoverPath } from '#lib/components/editor/uploads.ts';
	import { coverBackground } from '#lib/components/page-header/covers.ts';
	import { createRegistry, TITLE_PROP_ID, type PropValue, type PropertyDef } from '#lib/shared/property-types.ts';
	import type { FilterGroup } from '#lib/shared/filter-ast.ts';
	import type { Values, ViewRow } from '#lib/shared/protocol.ts';
	import { MAX_WINDOW } from '#lib/shared/protocol.ts';
	import { rankBetween } from '#lib/shared/sort-keys.ts';
	import { cellActions } from './cell-actions.ts';
	import type { ViewEnv } from './env.ts';
	import { FileNames } from './file-names.svelte.ts';
	import {
		dateProps,
		defaultGroupProp,
		neededProps,
		newRowInit,
		optionsOfView,
		rangeFilter,
		searchFilter,
		viewSubscription,
		visibleColumns,
		addDaysIso,
		isoDay
	} from './view-model.ts';
	import BoardView from './BoardView.svelte';
	import CalendarView from './CalendarView.svelte';
	import GalleryView from './GalleryView.svelte';
	import ListView from './ListView.svelte';
	import TableView from './TableView.svelte';
	import TimelineView from './TimelineView.svelte';
	import ViewTabs from './ViewTabs.svelte';
	import ViewToolbar from './ViewToolbar.svelte';

	let {
		workspaceId,
		collectionId,
		viewId,
		localFilter,
		readonly = false,
		href,
		onViewChange,
		fullPage = false
	}: {
		workspaceId: string;
		collectionId: string;
		viewId: string | null;
		localFilter: FilterGroup | null;
		readonly?: boolean;
		href?: (pageId: string) => string;
		onViewChange?: (viewId: string) => void;
		fullPage?: boolean;
	} = $props();

	const store = tryWorkspace();
	const link = (id: string) => (href ? href(id) : `/${workspaceId}/${id}`);

	// ───────────── definitions ─────────────
	let failure = $state<string | null>(null);
	$effect(() => {
		const id = collectionId;
		if (!store) return;
		let current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		untrack(() => {
			failure = null;
			void store.refreshProperties();
			// An inline database is created a moment after its block appears: a collection that is not there yet is asked
			// for again before the view gives up.
			const attempt = (n: number) =>
				void store.loadCollection(id, n > 0).then((found) => {
					if (!current || found || store.collections.get(id)) return;
					if (n >= 8) failure = 'This database no longer exists, or you cannot see it.';
					else timer = setTimeout(() => attempt(n + 1), 700);
				});
			attempt(0);
		});
		return () => {
			current = false;
			clearTimeout(timer);
		};
	});
	// Definitions are read again when the tab comes back (another person may have changed the views).
	$effect(() => {
		const onVisible = () => document.visibilityState === 'visible' && store?.refreshCollections();
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	const collection = $derived(store?.collections.get(collectionId));
	const views = $derived(store?.views.get(collectionId) ?? []);
	let activeId = $state<string | null>(untrack(() => viewId));
	$effect(() => {
		activeId = viewId;
	});
	const view = $derived(views.find((v) => v.id === activeId) ?? views[0]);
	const registry = $derived(createRegistry(store?.properties ?? []));
	const columns = $derived(visibleColumns(view ?? null, collection ?? null, store?.properties ?? []));

	function pickView(id: string) {
		activeId = id;
		onViewChange?.(id);
	}

	// ───────────── the subscription ─────────────
	let searchText = $state('');
	let search = $state('');
	$effect(() => {
		const text = searchText;
		const t = setTimeout(() => (search = text), 250);
		return () => clearTimeout(t);
	});

	/** The date range a calendar or timeline has loaded: a window around what it shows. */
	let range = $state<{ from: string; to: string } | null>(null);
	function showRange(from: string, to: string) {
		if (range && range.from <= from && range.to >= to) return;
		const pad = (iso: string, d: number) => addDaysIso(iso, d);
		range = { from: pad(from, -31), to: pad(to, 31) };
	}
	$effect(() => {
		void view?.id;
		range = null;
	});

	const dates = $derived(view ? dateProps(view, store?.properties ?? []) : { start: null, end: null });
	const LIMITS = { table: 100, list: 100, gallery: 60, board: 25, calendar: 500, timeline: 500 } as const;

	// A board without a group-by picks one.
	$effect(() => {
		const v = view;
		if (!store || !v || v.type !== 'board' || v.groupBy || !store.properties.length || readonly || !store.canEdit) return;
		const def = defaultGroupProp(store.properties);
		if (def) untrack(() => void store.updateView(collectionId, v.id, { groupBy: { prop: def.id } }).catch(() => undefined));
	});

	const sub = $derived.by(() => {
		if (!view || !collection) return null;
		const ranged = (view.type === 'calendar' || view.type === 'timeline') && dates.start;
		const r = range ?? (ranged ? defaultRange() : null);
		const extra: FilterGroup[] = [];
		const q = searchFilter(search);
		if (q) extra.push(q);
		if (ranged && r && dates.start) extra.push(rangeFilter(dates.start.id, dates.end?.id ?? null, r.from, r.to));
		return viewSubscription({
			collectionId,
			view,
			localFilter,
			extraFilter: extra.length ? { and: extra } : null,
			props: neededProps(view, columns, [dates.start?.id, dates.end?.id]),
			limit: LIMITS[view.type]
		});
	});
	function defaultRange() {
		const now = Date.now();
		return { from: addDaysIso(isoDay(now), -45), to: addDaysIso(isoDay(now), 75) };
	}
	const windowId = $derived(sub ? subKey('vw', collectionId + JSON.stringify(sub)) : null);
	$effect(() => {
		const id = windowId;
		const s = sub;
		if (!store || !id || !s) return;
		return store.subscribe(id, s);
	});

	const data = $derived(windowId && store ? store.viewData(windowId) : undefined);
	let retained = $state.raw<ViewData | undefined>();
	$effect(() => {
		const d = data;
		if (d && d.status === 'ready') retained = d;
	});
	$effect(() => {
		void view?.id;
		void collectionId;
		retained = undefined;
	});
	const shown = $derived(data && data.status === 'ready' ? data : retained);
	const windowFailed = $derived(data?.status === 'error');

	// ───────────── relation targets and file names ─────────────
	const files = new FileNames(untrack(() => workspaceId));
	let relationSubs = $state<string[]>([]);
	$effect(() => {
		if (!store || !shown) return;
		const relProps = columns.filter((c) => c.def.type === 'relation').map((c) => c.def.id);
		const fileProps = columns.filter((c) => c.def.type === 'files').map((c) => c.def.id);
		const rows = shown.groups ? shown.groups.flatMap((g) => g.rows) : shown.rows;
		const targets = new Set<string>();
		const fileIds = new Set<string>();
		for (const r of rows) {
			for (const id of relProps) for (const t of arr(r.values[id])) targets.add(t);
			for (const id of fileProps) for (const f of arr(r.values[id])) fileIds.add(f);
		}
		files.request(fileIds);
		const list = [...targets].filter((id) => !untrack(() => store.pages.has(id))).sort();
		const key = list.join(',');
		if (key === untrack(() => relationSubs.join('|'))) return;
		const chunks: string[][] = [];
		for (let i = 0; i < list.length && chunks.length < 4; i += 50) chunks.push(list.slice(i, i + 50));
		const ids = chunks.map((pageIds) => subKey('rel', pageIds.join(',')));
		const releases = chunks.map((pageIds, i) => store.subscribe(ids[i], { kind: 'page', pageIds }));
		relationSubs = ids;
		return () => releases.forEach((r) => r());
	});
	const arr = (v: PropValue | null | undefined): string[] => (Array.isArray(v) ? (v as string[]) : []);
	const lookups = $derived({
		members: store?.members ?? [],
		resolvePage: (id: string) => {
			const p = store?.resolvePage(id);
			if (p) return p;
			// Not loaded yet: show a placeholder until the subscriptions answered; then it is a deleted page.
			const answered = relationSubs.length > 0 && relationSubs.every((s) => store?.windows.get(s)?.status === 'ready');
			return answered ? null : { id, title: '…', icon: null };
		},
		fileInfo: files.info,
		pageHref: (id: string) => link(id)
	});

	// ───────────── writes ─────────────
	const editable = $derived(!readonly && !!store?.canEdit && (collection ? (store.page(collection.pageId)?.access ?? 'update') !== 'read' : false));

	async function newRow(extra: Values = {}, opts: { open?: boolean } = {}): Promise<string | null> {
		if (!store || !collection || !view || !editable) return null;
		// The server derives the starting values (`viewId`); this prediction is the optimistic layer's.
		const predicted = newRowInit({ collection, view, localFilter, registry, meId: store.user.id, extra });
		const id = newId('p');
		try {
			await store.createViewRow({ id, viewId: view.id, localFilter, predicted, extra });
			focusId = id;
			if (opts.open) await goto(link(id));
			return id;
		} catch (error) {
			const message = (error as { message?: string } | null)?.message;
			notifyError(message);
			return null;
		}
	}
	const notifyError = (description?: string) => toast.danger({ title: 'Could not create the page', description });

	let focusId = $state<string | null>(null);

	/**
	 * Manual reordering: the rows carry their ordering `rank` and `parentId` (the server keeps them current), so the
	 * new rank sits between the neighbours' without reading them. A hand-picked collection ranks its members
	 * (`moveMember`), any other keeps the page under its parent and ranks it among its siblings (`move`).
	 */
	async function moveRow(rowId: string, place: { before?: string | null; after?: string | null }) {
		if (!store || !collection || !shown) return;
		const held = new Map((shown.groups ? shown.groups.flatMap((g) => g.rows) : shown.rows).map((r) => [r.id, r]));
		const moved = held.get(rowId);
		const after = place.after ? held.get(place.after) : undefined;
		const before = place.before ? held.get(place.before) : undefined;
		if (!moved?.rank) return;
		const handPicked = collection.sourceAst === null;
		if (!handPicked) {
			for (const n of [after, before]) {
				if (n && (n.parentId ?? null) !== (moved.parentId ?? null)) {
					toast.info({ title: 'This page cannot be reordered here', description: 'It belongs to another parent.' });
					return;
				}
			}
		}
		try {
			const rank = rankBetween(after?.rank ?? null, before?.rank ?? null);
			await store.mutate([
				handPicked
					? { op: 'moveMember', collection: collection.id, page: rowId, rank }
					: { op: 'move', page: rowId, parentId: moved.parentId ?? null, rank }
			]);
		} catch {
			// the store has raised the toast, or the ranks collided (the next drop retries)
		}
	}

	async function updateView(patch: Parameters<ViewEnv['updateView']>[0]) {
		if (!store || !view) return;
		const id = windowId;
		await store.updateView(collectionId, view.id, patch);
		// In case the server does not recompute the window for this definition change: ask for a fresh snapshot.
		if (id && ('filter' in patch || 'sorts' in patch || 'groupBy' in patch || 'type' in patch)) store.resubscribe(id);
	}

	function loadMore(group?: string) {
		if (!store || !windowId || !shown || !view) return;
		if (group !== undefined) {
			const g = shown.groups?.find((x) => x.key === group);
			if (g) store.setWindow(windowId, Math.min(MAX_WINDOW, g.loaded + LIMITS.board), group);
		} else {
			const have = shown.rows.length;
			if (have < shown.total) store.growWindow(windowId, have + LIMITS[view.type]);
		}
	}

	const env = $derived.by((): ViewEnv | null => {
		if (!store || !collection || !view) return null;
		const s = store;
		const o = optionsOfView(view);
		return {
			store: s,
			workspaceId,
			collection,
			view,
			columns,
			properties: s.properties,
			editable,
			localFilter,
			fullPage,
			lookups,
			actions: (rowId: string, def: PropertyDef) => cellActions(s, rowId, def, files),
			href: link,
			open: (id, event) => {
				if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) return void window.open(link(id), '_blank');
				void goto(link(id));
			},
			setTitle: (rowId, title) => void s.setValue(rowId, TITLE_PROP_ID, title).catch(() => undefined),
			setValue: (rowId, prop, value) => s.setValue(rowId, prop, value).catch(() => undefined),
			newRow,
			updateView,
			setOption: (patch) => updateView({ columns: { columns: view.columns.columns, options: { ...view.columns.options, ...patch } } }),
			moveRow,
			manualOrder: view.sorts.length === 0 && search === '',
			loadMore,
			entity: (id) => s.page(id),
			cover: (row: ViewRow) => {
				if (o.coverProp) {
					const first = arr(row.values[o.coverProp])[0];
					if (first) return coverBackground(fileCoverPath(workspaceId, first));
				}
				return coverBackground(row.cover);
			}
		};
	});
</script>

{#snippet loading()}
	<div class="flex flex-col gap-2 px-3 py-3" aria-hidden="true" data-testid="view-skeleton">
		<Skeleton class="h-4 w-3/5" />
		<Skeleton class="h-4 w-2/5" />
		<Skeleton class="h-4 w-1/2" />
	</div>
{/snippet}

<div class="view-host" class:full={fullPage} data-testid="view-host" data-view-type={view?.type} data-state={failure && !collection ? 'error' : shown && env ? 'ready' : 'loading'} aria-busy={!shown && !(failure && !collection)}>
	{#if !store}
		<Alert color="info" variant="soft" size="small">Open this page in the app to see its database.</Alert>
	{:else if failure && !collection}
		<Alert color="danger" variant="soft" size="small" data-testid="view-error">
			<span class="flex items-center gap-2">
				{failure}
				<Button variant="ghost" size="small" onclick={() => void store.loadCollection(collectionId, true)}>Try again</Button>
			</span>
		</Alert>
	{:else if !env || !view}
		{@render loading()}
	{:else}
		<div class="chrome">
			<ViewTabs {env} {views} activeId={view.id} onPick={pickView} />
			<ViewToolbar {env} bind:search={searchText} />
		</div>
		{#if windowFailed && !shown}
			<Alert color="danger" variant="soft" size="small" data-testid="view-error">This view could not be loaded.</Alert>
		{:else if !shown}
			{@render loading()}
		{:else if view.type === 'table'}
			<TableView {env} data={shown} bind:focusId />
		{:else if view.type === 'board'}
			<BoardView {env} data={shown} />
		{:else if view.type === 'list'}
			<ListView {env} data={shown} />
		{:else if view.type === 'gallery'}
			<GalleryView {env} data={shown} />
		{:else if view.type === 'calendar'}
			<CalendarView {env} data={shown} onRange={showRange} />
		{:else if view.type === 'timeline'}
			<TimelineView {env} data={shown} onRange={showRange} />
		{/if}
		{#if shown && !shown.groups && shown.rows.length >= MAX_WINDOW && shown.total > shown.rows.length}
			<Alert color="info" variant="soft" size="small" data-testid="view-window-cap">
				Showing the first {MAX_WINDOW.toLocaleString('en-US')} of {shown.total.toLocaleString('en-US')} rows. Search or filter to narrow this view.
			</Alert>
		{/if}
	{/if}
</div>

<style>
	.view-host {
		color: var(--app-text);
		font-size: 14px;
		min-width: 0;
	}
	.chrome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 36px;
		border-bottom: 1px solid var(--app-hairline);
		margin-bottom: 2px;
	}
	/* On a phone the tabs and the toolbar do not fit side by side: the tabs take a line, the toolbar the next. */
	@media (max-width: 767px) {
		.chrome {
			flex-wrap: wrap;
			row-gap: 0;
		}
		.chrome > :global(*) {
			flex: 1 1 100%;
			min-width: 0;
		}
		.chrome > :global(:last-child) {
			justify-content: flex-start;
			overflow-x: auto;
		}
	}
</style>
