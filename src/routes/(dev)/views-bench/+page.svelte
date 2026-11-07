<!--
	Dev only. The table layout over thousands of synthetic rows, with no server: the page that proves the Data table
	virtualizes (`?rows=5000`) and that inline editing keeps working at the end of the list. The cells write into
	local state, as the store would write through the socket.
-->
<script lang="ts">
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import type { ViewEnv } from '#lib/components/views/env.ts';
	import TableView from '#lib/components/views/TableView.svelte';
	import { TITLE_PROP_ID, type PropValue, type PropertyDef } from '#lib/shared/property-types.ts';
	import type { ViewDef } from '#lib/shared/definitions.ts';
	import type { ViewRow } from '#lib/shared/protocol.ts';

	const defs: PropertyDef[] = [
		{ id: TITLE_PROP_ID, name: 'Name', type: 'title', config: {} },
		{ id: 'status', name: 'Status', type: 'status', config: { options: [{ id: 'todo', name: 'To do', color: 'gray' }, { id: 'doing', name: 'Doing', color: 'blue' }, { id: 'done', name: 'Done', color: 'green' }], groups: [] } },
		{ id: 'score', name: 'Score', type: 'number', config: {} },
		{ id: 'note', name: 'Note', type: 'text', config: {} },
		{ id: 'ok', name: 'OK', type: 'checkbox', config: {} },
		{ id: 'due', name: 'Due', type: 'date', config: {} }
	] as PropertyDef[];

	const make = (n: number): ViewRow[] =>
		Array.from({ length: n }, (_, i) => ({
			id: `r${i + 1}`,
			title: `Row ${i + 1}`,
			icon: null,
			values: { status: ['todo', 'doing', 'done'][i % 3], score: i, note: `note ${i + 1}`, ok: i % 2 === 0, due: { start: '2026-11-21' } }
		}));

	let rows = $state.raw<ViewRow[]>(untrackedRows());
	function untrackedRows() {
		return make(Math.min(20_000, Number(new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('rows') ?? 5000) || 5000));
	}
	let edits = $state(0);

	function write(id: string, prop: string, value: PropValue | null) {
		edits++;
		rows = rows.map((r) => (r.id === id ? (prop === TITLE_PROP_ID ? { ...r, title: String(value ?? '') } : { ...r, values: { ...r.values, [prop]: value } }) : r));
		return Promise.resolve({ seq: edits });
	}

	const view = { id: 'v', collectionId: 'c', type: 'table', name: 'Table', filter: { and: [] }, sorts: [], groupBy: null, columns: { columns: [], options: {} }, rank: '10' } as ViewDef;
	const env: ViewEnv = {
		store: {} as ViewEnv['store'],
		workspaceId: 'bench',
		collection: { id: 'c', pageId: 'c', sourceAst: null, shownProps: [], defaults: {} },
		view,
		columns: defs.map((def) => ({ def, width: def.id === TITLE_PROP_ID ? 240 : 140 })),
		properties: defs,
		editable: true,
		localFilter: null,
		fullPage: true,
		lookups: { members: [] },
		actions: (rowId, def) => ({
			onSet: (value) => void write(rowId, def.id, value),
			onAdd: () => undefined,
			onRemove: () => undefined
		}),
		href: (id) => `/bench/${id}`,
		open: () => undefined,
		setTitle: (id, title) => void write(id, TITLE_PROP_ID, title),
		setValue: (id, prop, value) => write(id, prop, value),
		newRow: async () => null,
		updateView: async () => undefined,
		setOption: async () => undefined,
		moveRow: async () => undefined,
		manualOrder: false,
		loadMore: () => undefined,
		entity: () => undefined,
		cover: () => null
	};
	const data = $derived<ViewData>({ status: 'ready', total: rows.length, rows });
</script>

<svelte:head><title>Views bench · Flarion</title></svelte:head>

<div class="mx-auto max-w-[1100px] p-8" data-testid="bench">
	<p class="mb-2 text-sm" data-testid="bench-edits">{rows.length} rows, {edits} edits</p>
	<TableView {env} {data} />
</div>
