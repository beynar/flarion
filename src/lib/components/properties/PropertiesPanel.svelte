<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from 'entasis/button';
	import { rpc } from '#lib/client/rpc.ts';
	import { fileUrl, uploadToPage } from '#lib/components/editor/uploads.ts';
	import type { PageEntity, WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { PropValue, PropertyDef, PropertyType } from '#lib/shared/property-types.ts';
	import AddProperty from './AddProperty.svelte';
	import PropertyEditor from './PropertyEditor.svelte';
	import PropertyLabel from './PropertyLabel.svelte';
	import {
		configWithOption,
		isEmpty,
		isOptionType,
		makeOption,
		newPropertyDef,
		optionByName,
		optionsOf,
		valueIds
	} from './helpers.ts';

	/**
	 * The property panel of the page header.
	 *
	 * Which rows show: every workspace property the page has a value for, plus the ones the user added
	 * or attached in this session while still empty. The other (empty) properties hide behind
	 * "Show N empty properties". The registry is workspace-wide, so a property created on one page is
	 * offered on every other page under "Existing properties" in "Add a property".
	 *
	 * Writes go through the store's optimistic ops. Only `update` and `full` access edit, and only
	 * while the workspace socket is online; `read` and `comment` see the plain displays.
	 */
	let { store, page }: { store: WorkspaceStore; page: PageEntity } = $props();

	const canEditPage = $derived(page.access === 'update' || page.access === 'full');
	const editable = $derived(canEditPage && store.canEdit);

	const pinned = new SvelteSet<string>();
	let showEmpty = $state(false);
	let focusId = $state<string | null>(null);
	const editors: Record<string, { open: () => Promise<void> } | undefined> = $state({});

	// A new page starts with its own pinned set.
	let lastPage = untrack(() => page.id);
	$effect(() => {
		if (page.id !== lastPage) {
			lastPage = page.id;
			pinned.clear();
			showEmpty = false;
		}
	});

	// The registry can lag behind another client's changes: fetch it when a page opens.
	$effect(() => {
		void page.id;
		untrack(() => void store.refreshProperties());
	});

	const defs = $derived(store.properties.filter((d) => d.type !== 'title'));

	/** The value a row shows: stored values, or the page's own columns for the created/edited types. */
	function valueOf(def: PropertyDef): PropValue | null {
		switch (def.type) {
			case 'created_time':
				return page.createdAt || null;
			case 'created_by':
				return page.createdBy;
			case 'last_edited_time':
				return page.updatedAt || null;
			case 'last_edited_by':
				return page.updatedBy;
			default:
				return page.values[def.id] ?? null;
		}
	}

	const rows = $derived(defs.map((def) => ({ def, value: valueOf(def) })));
	const shown = $derived(rows.filter((r) => showEmpty || pinned.has(r.def.id) || !isEmpty(r.def, r.value)));
	const hidden = $derived(rows.filter((r) => !shown.includes(r)));

	// Another client's new option (or a rename) reaches the registry by refetching it once per change.
	let lastMissing = '';
	$effect(() => {
		const missing: string[] = [];
		for (const r of rows) {
			if (!isOptionType(r.def.type)) continue;
			const known = new Set(optionsOf(r.def).map((o) => o.id));
			for (const id of valueIds(r.value)) if (!known.has(id)) missing.push(`${r.def.id}:${id}`);
		}
		const key = missing.sort().join(',');
		if (key && key !== lastMissing) untrack(() => void store.refreshProperties());
		lastMissing = key;
	});

	// Focus the editor of a property just created or attached.
	$effect(() => {
		const id = focusId;
		if (!id) return;
		const ed = editors[id];
		if (!ed) return;
		focusId = null;
		void tick().then(() => ed.open());
	});

	const lookups = $derived({
		members: store.members,
		resolvePage: (id: string) => store.resolvePage(id),
		pageHref: (id: string) => `/${store.workspace.slug}/${id}`
	});

	// ───────────── file names ─────────────
	let fileNames = $state<Record<string, { name: string; url?: string }>>({});
	const fileMiss = new Set<string>();
	$effect(() => {
		const need = rows
			.filter((r) => r.def.type === 'files')
			.flatMap((r) => valueIds(r.value))
			.filter((id) => !fileNames[id] && !fileMiss.has(id));
		for (const id of need) {
			fileMiss.add(id);
			void Promise.resolve()
				.then(() => rpc.files.get({ fileId: id }))
				.then((info) => (fileNames[id] = { name: info.name, url: fileUrl(store.workspace.id, id) }))
				.catch(() => undefined);
		}
	});

	/**
	 * The files property's upload: the editor's flow (`files.begin`, the bytes, `files.complete`; multipart for a
	 * large file, see components/editor/uploads.ts). Every file is stored under this page, and the chip links to the
	 * stable, permission-checked URL rather than to the short-lived signed one.
	 */
	async function upload(files: File[]): Promise<string[]> {
		const ids: string[] = [];
		for (const file of files) {
			const { fileId } = await uploadToPage(file, { workspaceId: store.workspace.id, pageId: page.id, rpc });
			fileNames[fileId] = { name: file.name, url: fileUrl(store.workspace.id, fileId) };
			ids.push(fileId);
		}
		return ids;
	}

	// ───────────── writes ─────────────
	const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // the store has raised the toast

	async function createOption(def: PropertyDef, name: string) {
		try {
			let option = optionByName(def, name);
			if (!option) {
				option = makeOption(def, name) ?? undefined;
				if (!option) return;
				// The definition lands first: a batch cannot reference an option it creates.
				await store.updateProperty(def.id, { config: configWithOption(def, option) });
			}
			if (def.type === 'multi_select') await store.addOption(page.id, def.id, option.id);
			else await store.setValue(page.id, def.id, option.id);
		} catch {
			// reported by the store
		}
	}

	function createProperty(type: PropertyType, name: string) {
		const def = newPropertyDef(type, name);
		pinned.add(def.id);
		focusId = def.id;
		quiet(store.createProperty(def));
	}

	function attach(def: PropertyDef) {
		pinned.add(def.id);
		focusId = def.id;
	}

	const attachable = $derived(hidden.map((r) => r.def));
</script>

{#if rows.length || editable}
	<div class="mb-2 flex flex-col pb-2" data-testid="properties-panel" role="group" aria-label="Properties">
		{#each shown as { def, value } (def.id)}
			<div class="flex items-start gap-2" style="min-height: var(--app-property-row-height); padding-block: 3px" data-testid="property-row" data-property-id={def.id} data-type={def.type}>
				<PropertyLabel
					{def}
					editable={editable && def.type !== 'unique_id'}
					onRename={(name) => quiet(store.updateProperty(def.id, { name }))}
					onConfig={(config) => quiet(store.updateProperty(def.id, { config }))}
					onDelete={() => quiet(store.deleteProperty(def.id))}
				/>
				<PropertyEditor
					bind:this={editors[def.id]}
					{def}
					{value}
					{editable}
					{store}
					{...lookups}
					fileInfo={(id) => fileNames[id]}
					onSet={(v) => quiet(store.setValue(page.id, def.id, v))}
					onAdd={(o) => quiet(store.addOption(page.id, def.id, o))}
					onRemove={(o) => quiet(store.removeOption(page.id, def.id, o))}
					onConfigChange={(config) => quiet(store.updateProperty(def.id, { config }))}
					onCreateOption={createOption}
					onUpload={upload}
				/>
			</div>
		{/each}

		<div class="mt-1 flex flex-wrap items-center gap-x-1">
			{#if hidden.length}
				<Button
					variant="ghost"
					color="neutral"
					size="small"
					class="font-normal text-[color:var(--app-text-tertiary)]"
					data-testid="toggle-empty"
					expanded={showEmpty}
					onclick={() => (showEmpty = !showEmpty)}
				>
					{showEmpty ? 'Hide' : 'Show'} {hidden.length} empty {hidden.length === 1 ? 'property' : 'properties'}
				</Button>
			{:else if showEmpty && rows.length}
				<Button
					variant="ghost"
					color="neutral"
					size="small"
					class="font-normal text-[color:var(--app-text-tertiary)]"
					data-testid="toggle-empty"
					expanded
					onclick={() => (showEmpty = false)}
				>
					Hide empty properties
				</Button>
			{/if}
			{#if editable}
				<AddProperty existing={attachable} names={defs} onCreate={createProperty} onAttach={attach} />
			{/if}
		</div>
	</div>
{/if}
