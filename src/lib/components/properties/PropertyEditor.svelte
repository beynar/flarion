<script lang="ts">
	import { tick } from 'svelte';
	import { Popover } from 'entasis/popover';
	import { Checkbox } from 'entasis/checkbox';
	import { NumberInput } from 'entasis/number-input';
	import { TextInput } from 'entasis/text-input';
	import { Button } from 'entasis/button';
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
		const el = cell?.querySelector('input');
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

	// The cell is an entasis ghost Button that fills the value column (Notion's hover-highlighted value).
	const cellClass = 'h-auto min-h-[28px] w-full min-w-0 justify-start px-1.5 py-[3px] text-left text-sm font-normal text-[color:var(--app-text)]';
</script>

<div class="min-w-0 flex-1" data-testid="property-value" data-type={type} bind:this={cell}>
	{#if type === 'checkbox' && canEdit}
		<div class="flex min-h-[28px] items-center pl-0.5">
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
			<TextInput
				size="small"
				type={type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
				bind:value={draft}
				inputAttrs={{
					'aria-label': def.name,
					...(type === 'phone' ? { inputmode: 'tel', autocomplete: 'tel' } : {}),
					onblur: commitText,
					onkeydown: (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							commitText();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							cancelText();
						}
					}
				}}
			/>
		{:else}
			<Button variant="ghost" color="neutral" class={cellClass} label={`Edit ${def.name}`} onclick={() => void startEditing()}>
				<PropertyValue {def} {value} {members} {resolvePage} {fileInfo} {pageHref} {compact} />
			</Button>
		{/if}
	{:else if popup}
		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open={popoverOpen} offset={4}>
			{#snippet trigger(popover)}
				<Button variant="ghost" color="neutral" class={cellClass} label={`Edit ${def.name}`} haspopup="dialog" {@attach popover.trigger}>
					<PropertyValue {def} {value} {members} {resolvePage} {fileInfo} {pageHref} {compact} />
				</Button>
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
