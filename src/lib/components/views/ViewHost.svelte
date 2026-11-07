<!--
	The seam between the editor's `database_view` block (and, later, a full-page database) and the view
	components. P2 renders a working table-shaped READ view through `rpc.collection.query`; P3's App UI replaces
	this component with the table, board, list, gallery, calendar and timeline views on live windows, keeping the
	props below.

	  workspaceId   the workspace the collection lives in (the calls carry it)
	  collectionId  the collection to show
	  viewId        a view of it, or null for its first view
	  localFilter   an extra filter ANDed with the view's, local to the block (null for none)

	It refreshes itself (every few seconds, on focus and after adding a row) because it is not a live window yet.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { createRpc, type Rpc } from '#lib/client/rpc.ts';
	import type { FilterGroup } from '#lib/shared/filter-ast.ts';
	import type { CollectionDef, ViewDef } from '#lib/shared/definitions.ts';
	import { TITLE_PROP_ID, type PropertyDef } from '#lib/shared/property-types.ts';
	import type { QueryPage } from '#lib/shared/schemas.ts';
	import { cellText } from './format-cell.ts';

	let {
		workspaceId,
		collectionId,
		viewId,
		localFilter,
		readonly = false,
		href,
		client
	}: {
		workspaceId: string;
		collectionId: string;
		viewId: string | null;
		localFilter: FilterGroup | null;
		/** Hides the "New" row (a locked or read-only page). */
		readonly?: boolean;
		/** Where a row's page lives (default `/<workspaceId>/<pageId>`). */
		href?: (pageId: string) => string;
		/** A client to call through (tests, the standalone editor); default: the app's, scoped to `workspaceId`. */
		client?: Rpc;
	} = $props();

	const REFRESH_MS = 10_000;
	const PAGE_SIZE = 50;

	const api = $derived(client ?? createRpc({ getWorkspaceId: () => workspaceId }));
	const link = (id: string) => (href ? href(id) : `/${workspaceId}/${id}`);

	type Loaded = {
		collection: CollectionDef;
		view: ViewDef | null;
		views: ViewDef[];
		properties: PropertyDef[];
		members: Map<string, string>;
		page: QueryPage;
	};

	let loaded = $state<Loaded>();
	let failure = $state<string>();
	let busy = $state(false);
	let adding = $state(false);

	async function load(): Promise<void> {
		const rpcClient = api;
		const id = collectionId;
		const wanted = viewId;
		const filter = localFilter;
		try {
			const [found, properties] = await Promise.all([rpcClient.collection.get({ id }), rpcClient.property.list()]);
			const view = found.views.find((candidate) => candidate.id === wanted) ?? found.views[0] ?? null;
			const page = await rpcClient.collection.query({
				collectionId: id,
				...(view ? { viewId: view.id } : {}),
				...(filter ? { spec: { filter } } : {}),
				limit: PAGE_SIZE
			});
			const members = new Map<string, string>();
			if (properties.some((p) => ['person', 'created_by', 'last_edited_by'].includes(p.type))) {
				try {
					for (const m of await rpcClient.workspace.members.list()) members.set(m.userId, m.name);
				} catch {
					// Names are a nicety: ids show as "Someone".
				}
			}
			if (id !== collectionId) return;
			loaded = { collection: found.collection, view, views: found.views, properties, members, page };
			failure = undefined;
		} catch (error) {
			if (id !== collectionId) return;
			failure = describe(error);
		}
	}

	function describe(error: unknown): string {
		const code = (error as { code?: string } | null)?.code;
		if (code === 'NOT_FOUND') return 'This database no longer exists, or you cannot see it.';
		if (code === 'NOT_IMPLEMENTED') return 'This view is not available yet.';
		return error instanceof Error && error.message ? error.message : 'This view could not be loaded.';
	}

	async function refresh() {
		busy = true;
		try {
			await load();
		} finally {
			busy = false;
		}
	}

	// A different collection, view or filter reloads from scratch.
	$effect(() => {
		void collectionId;
		void viewId;
		void JSON.stringify(localFilter);
		void workspaceId;
		untrack(() => {
			loaded = undefined;
			failure = undefined;
			void refresh();
		});
	});

	onMount(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, REFRESH_MS);
		const onVisible = () => document.visibilityState === 'visible' && void load();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	/** The columns: the view's visible ones, else the collection's shown properties; the title always leads. */
	const columns = $derived.by(() => {
		if (!loaded) return [] as { id: string; name: string; def: PropertyDef | undefined }[];
		const byId = new Map(loaded.properties.map((p) => [p.id, p]));
		const fromView = loaded.view?.columns.columns.filter((c) => !c.hidden).map((c) => c.prop) ?? [];
		const ids = (fromView.length > 0 ? fromView : loaded.collection.shownProps).filter((id) => id !== TITLE_PROP_ID);
		return [
			{ id: TITLE_PROP_ID, name: byId.get(TITLE_PROP_ID)?.name ?? 'Name', def: byId.get(TITLE_PROP_ID) },
			...ids.flatMap((id) => {
				const def = byId.get(id);
				return def ? [{ id, name: def.name, def }] : [];
			})
		];
	});

	async function addRow() {
		if (!loaded || adding || readonly) return;
		adding = true;
		try {
			await api.page.create({ parentId: loaded.collection.pageId, values: { [TITLE_PROP_ID]: 'Untitled' } });
			await load();
		} catch (error) {
			failure = describe(error);
		} finally {
			adding = false;
		}
	}
</script>

<div class="view-host" data-testid="view-host" data-state={failure ? 'error' : loaded ? 'ready' : 'loading'} aria-busy={!loaded && !failure}>
	{#if failure && !loaded}
		<div class="note" role="alert">
			<span>{failure}</span>
			<button type="button" onclick={() => void refresh()}>Try again</button>
		</div>
	{:else if !loaded}
		<div class="note" aria-hidden="true"><span class="skeleton"></span></div>
	{:else}
		<div class="scroll">
			<table class="grid" data-view-type={loaded.view?.type ?? 'table'}>
				<thead>
					<tr>
						{#each columns as column (column.id)}
							<th scope="col">{column.name}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each loaded.page.rows as row (row.id)}
						<tr data-testid="view-row" data-row-id={row.id}>
							{#each columns as column (column.id)}
								<td data-prop={column.id}>
									{#if column.id === TITLE_PROP_ID}
										<a class="title" href={link(row.id)} data-testid="view-row-title">
											{#if row.icon}<span class="icon" aria-hidden="true">{row.icon}</span>{/if}
											<span>{row.title || 'Untitled'}</span>
										</a>
									{:else}
										{cellText(column.def, row.values[column.id], loaded.members)}
									{/if}
								</td>
							{/each}
						</tr>
					{:else}
						<tr class="empty">
							<td colspan={columns.length} data-testid="view-empty">No pages yet</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="foot">
			{#if !readonly}
				<button type="button" class="add" data-testid="view-add-row" disabled={adding} onclick={() => void addRow()}>+ New page</button>
			{/if}
			<span class="count" data-testid="view-count">
				{loaded.page.total} {loaded.page.total === 1 ? 'page' : 'pages'}{loaded.page.nextCursor ? ` · showing ${loaded.page.rows.length}` : ''}
			</span>
			{#if failure}<span class="warn" role="alert">{failure}</span>{/if}
			{#if busy}<span class="count" aria-live="polite">Refreshing…</span>{/if}
		</div>
	{/if}
</div>

<style>
	.view-host {
		color: var(--app-text);
		font-size: 14px;
	}
	.scroll {
		overflow-x: auto;
	}
	.grid {
		width: 100%;
		min-width: 100%;
		border-collapse: collapse;
		table-layout: auto;
	}
	th,
	td {
		padding: 6px 10px;
		text-align: left;
		white-space: nowrap;
		border-bottom: 1px solid var(--app-hairline);
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	th {
		font-weight: 500;
		font-size: 12px;
		color: var(--app-text-secondary);
		border-top: 1px solid var(--app-hairline);
	}
	tbody tr:hover {
		background: var(--app-hover);
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: inherit;
		font-weight: 500;
		text-decoration: none;
	}
	.title:hover span:last-child {
		text-decoration: underline;
		text-decoration-color: var(--app-text-tertiary, var(--app-text-secondary));
	}
	.empty td {
		color: var(--app-text-secondary);
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 4px 0;
		font-size: 12px;
		color: var(--app-text-secondary);
	}
	.add {
		color: var(--app-text-secondary);
		cursor: pointer;
		padding: 2px 6px;
		border-radius: var(--app-radius-control);
	}
	.add:hover:not(:disabled) {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.warn {
		color: var(--app-danger, #c4554d);
	}
	.note {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		color: var(--app-text-secondary);
	}
	.note button {
		color: var(--app-accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.skeleton {
		display: block;
		width: 60%;
		height: 14px;
		border-radius: 4px;
		background: var(--app-hover);
	}
</style>
