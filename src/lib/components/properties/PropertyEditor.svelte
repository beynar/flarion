<script lang="ts">
	import { tick } from 'svelte';
	import { Popover } from 'entasis/popover';
	import { Checkbox } from 'entasis/checkbox';
	import { NumberInput } from 'entasis/number-input';
	import PagePicker from '#lib/components/pickers/PagePicker.svelte';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { DateValue } from '#lib/shared/dates.ts';
	import { isDateValue, type PropValue, type PropertyDef } from '#lib/shared/property-types.ts';
	import DateEditor from './DateEditor.svelte';
	import FilesEditor from './FilesEditor.svelte';
	import OptionsEditor from './OptionsEditor.svelte';
	import PersonPicker from './PersonPicker.svelte';
	import PropertyValue from './PropertyValue.svelte';
	import SelectPicker from './SelectPicker.svelte';
	import { isReadOnlyType, valueIds } from './helpers.ts';
	import type { PropertyEditorCallbacks, PropertyLookups } from './types.ts';

	/**
	 * The editing cell of one property: the value as `PropertyValue` that opens the right editor when
	 * activated. Controlled, with no page or store inside: `value` in, callbacks out (`onSet`, `onAdd`,
	 * `onRemove`, `onConfigChange`, `onCreateOption`, `onUpload`). `editable=false` and the computed or
	 * assigned types render the plain display. `store` is only for the relation picker (a page search).
	 * Call `open()` to focus the editor (the panel does after creating a property).
	 */
	let {
		def,
		value,
		editable = true,
		members,
		resolvePage,
		fileInfo,
		pageHref,
		store,
		compact = false,
		onSet,
		onAdd,
		onRemove,
		onConfigChange,
		onCreateOption,
		onUpload
	}: {
		def: PropertyDef;
		value: PropValue | null | undefined;
		editable?: boolean;
		compact?: boolean;
		store?: WorkspaceStore;
	} & PropertyLookups &
		PropertyEditorCallbacks = $props();

	const canEdit = $derived(editable && !isReadOnlyType(def.type));
	const type = $derived(def.type);
	const inline = $derived(type === 'text' || type === 'url' || type === 'email' || type === 'phone' || type === 'number');
	const popup = $derived(
		canEdit &&
			(type === 'select' ||
				type === 'status' ||
				type === 'multi_select' ||
				type === 'person' ||
				type === 'date' ||
				type === 'files' ||
				(type === 'relation' && !!store))
	);

	let popoverOpen = $state(false);
	let view = $state<'pick' | 'options'>('pick');
	let editing = $state(false);
	let draft = $state('');
	let inputEl = $state<HTMLInputElement>();
	let cell = $state<HTMLElement>();

	$effect(() => {
		if (!popoverOpen) view = 'pick';
	});

	/** Opens the editor of this cell. */
	export async function open() {
		if (!canEdit) return;
		if (type === 'checkbox') return;
		if (inline) startEditing();
		else popoverOpen = true;
		await tick();
	}

	const textOf = (v: PropValue | null | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

	async function startEditing() {
		if (!canEdit) return;
		draft = textOf(value);
		editing = true;
		await tick();
		const el = inputEl ?? cell?.querySelector('input');
		el?.focus();
		el?.select();
	}
	function commitText() {
		if (!editing) return;
		editing = false;
		const next = draft.trim();
		if (next === textOf(value)) return;
		onSet(next === '' ? null : next);
	}
	function cancelText() {
		editing = false;
	}

	function commitNumber(v: number | null) {
		editing = false;
		const cur = typeof value === 'number' ? value : null;
		if (v === cur) return;
		onSet(v);
	}

	const ids = $derived(valueIds(value));
	const dateValue = $derived(isDateValue(value) ? (value as DateValue) : null);

	function pickOption(id: string, close: () => void) {
		if (type === 'multi_select') {
			if (ids.includes(id)) onRemove?.(id);
			else onAdd?.(id);
		} else {
			onSet(ids.includes(id) ? null : id);
			close();
		}
	}
	function togglePerson(id: string) {
		if (ids.includes(id)) onRemove?.(id);
		else onAdd?.(id);
	}
	function pickPage(id: string, close: () => void) {
		const one = (def.config as { limit?: string }).limit === 'one';
		if (one) {
			onSet([id]);
			close();
		} else if (ids.includes(id)) onRemove?.(id);
		else onAdd?.(id);
	}
	async function upload(files: File[]) {
		if (!onUpload) return;
		const added = await onUpload(files);
		for (const id of added) onAdd?.(id);
	}

	const cellClass =
		'flex min-h-[28px] w-full min-w-0 cursor-pointer items-center rounded-[var(--app-radius-control)] px-1.5 py-[3px] text-left text-sm hover:bg-[color:var(--app-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-accent)]';
	const inputClass =
		'w-full min-w-0 rounded-[var(--app-radius-control)] border border-[color:var(--app-accent)] bg-[color:var(--app-page)] px-1.5 text-sm text-[color:var(--app-text)] outline-none';
</script>

<div class="min-w-0 flex-1" data-testid="property-value" data-type={type} bind:this={cell}>
	{#if type === 'checkbox' && canEdit}
		<div class="flex min-h-[28px] items-center px-1.5">
			<Checkbox
				size="small"
				value={value === true}
				onValueChange={(on) => onSet(!!on)}
				inputAttrs={{ 'aria-label': def.name }}
			/>
		</div>
	{:else if inline && canEdit}
		{#if editing && type === 'number'}
			<NumberInput
				size="small"
				showControls={false}
				value={typeof value === 'number' ? value : null}
				onValueCommit={({ value: v }) => commitNumber(v)}
				inputAttrs={{ 'aria-label': def.name }}
			/>
		{:else if editing}
			<input
				bind:this={inputEl}
				class={inputClass}
				style="height: 28px"
				type={type === 'email' ? 'email' : type === 'url' ? 'url' : type === 'phone' ? 'tel' : 'text'}
				aria-label={def.name}
				bind:value={draft}
				onblur={commitText}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commitText();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						cancelText();
					}
				}}
			/>
		{:else}
			<div
				role="button"
				tabindex="0"
				class={cellClass}
				aria-label={`Edit ${def.name}`}
				onclick={() => {
					void startEditing();
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						void startEditing();
					}
				}}
			>
				<PropertyValue {def} {value} {members} {resolvePage} {fileInfo} {pageHref} {compact} />
			</div>
		{/if}
	{:else if popup}
		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open={popoverOpen} offset={4}>
			{#snippet trigger(popover)}
				<button type="button" class={cellClass} aria-label={`Edit ${def.name}`} aria-haspopup="dialog" {@attach popover.trigger}>
					<PropertyValue {def} {value} {members} {resolvePage} {fileInfo} {pageHref} {compact} />
				</button>
			{/snippet}
			{#snippet children(popover)}
				{#if type === 'select' || type === 'status' || type === 'multi_select'}
					{#if view === 'options'}
						<OptionsEditor {def} onConfig={(c) => onConfigChange?.(c)} onBack={() => (view = 'pick')} />
					{:else}
						<SelectPicker
							{def}
							selected={ids}
							canEdit={!!onConfigChange}
							onPick={(id) => pickOption(id, () => popover.close())}
							onCreate={(name) => {
								onCreateOption?.(def, name);
								if (type !== 'multi_select') popover.close();
							}}
							onEditOptions={() => (view = 'options')}
						/>
					{/if}
				{:else if type === 'person'}
					<PersonPicker {members} selected={ids} onPick={togglePerson} />
				{:else if type === 'date'}
					<DateEditor
						value={dateValue}
						includeTime={!!(def.config as { includeTime?: boolean }).includeTime}
						onSet={(v) => onSet(v as PropValue | null)}
						onConfigIncludeTime={(on) => onConfigChange?.({ ...def.config, includeTime: on })}
					/>
				{:else if type === 'files'}
					<FilesEditor
						{ids}
						name={(id) => fileInfo?.(id)?.name ?? 'File'}
						onUpload={onUpload ? upload : undefined}
						onRemove={(id) => onRemove?.(id)}
					/>
				{:else if type === 'relation' && store}
					<div class="w-[300px]">
						<PagePicker {store} placeholder="Link a page…" onpick={(id) => pickPage(id, () => popover.close())} />
					</div>
				{/if}
			{/snippet}
		</Popover>
	{:else}
		<div class="flex min-h-[28px] w-full min-w-0 items-center px-1.5 py-[3px]">
			<PropertyValue {def} {value} {members} {resolvePage} {fileInfo} {pageHref} {compact} />
		</div>
	{/if}
</div>
