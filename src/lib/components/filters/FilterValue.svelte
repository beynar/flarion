<script lang="ts">
	import { Popover } from 'entasis/popover';
	import PagePicker from '#lib/components/pickers/PagePicker.svelte';
	import PersonPicker from '#lib/components/properties/PersonPicker.svelte';
	import SelectPicker from '#lib/components/properties/SelectPicker.svelte';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import { findOption, optionColorName } from '#lib/components/properties/helpers.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { DateOperand, DateRangeOperand, NamedRange } from '#lib/shared/dates.ts';
	import type { FilterValue } from '#lib/shared/filter-ast.ts';
	import type { FilterOp, FilterValueKind, PropertyDef } from '#lib/shared/property-types.ts';
	import type { Member } from '#lib/shared/schemas.ts';
	import DateOperandEditor from './DateOperandEditor.svelte';
	import { DEFAULT_RELATIVE, NAMED_RANGE_CHOICES } from './logic.ts';
	import { controlClass } from './styles.ts';

	/**
	 * The value editor of one condition, by the kind its operator takes: text, number, checked or not, an
	 * option / person / page picker, a date operand or a date range. `onValue` is a typing change (debounced by the
	 * builder); picks and selects go through the same callback and are committed at once by `immediate`.
	 */
	let {
		def,
		op,
		kind,
		value,
		store,
		members,
		readonly = false,
		onValue,
		onOp
	}: {
		def: PropertyDef | undefined;
		op: FilterOp;
		kind: FilterValueKind;
		value: FilterValue | undefined;
		store: WorkspaceStore;
		members: readonly Member[];
		readonly?: boolean;
		onValue: (value: FilterValue | undefined, immediate: boolean) => void;
		/** "Me" in a person picker switches the operator to `is me` / `is not me`. */
		onOp?: (op: FilterOp) => void;
	} = $props();

	let open = $state(false);
	const refText = $derived(typeof value === 'string' ? value : '');
	const optionLike = $derived(def?.type === 'select' || def?.type === 'status' || def?.type === 'multi_select');
	const personLike = $derived(def?.type === 'person' || def?.type === 'created_by' || def?.type === 'last_edited_by');
	const person = $derived(members.find((m) => m.userId === refText));
	const page = $derived(refText && !optionLike && !personLike ? store.resolvePage(refText) : null);
	const option = $derived(def && optionLike && refText ? findOption(def, refText) : undefined);

	const isRange = (x: unknown): x is DateRangeOperand => !!x && typeof x === 'object' && 'kind' in x && (x.kind === 'named' || x.kind === 'between');
	const isOperand = (x: unknown): x is DateOperand => !!x && typeof x === 'object' && 'kind' in x && (x.kind === 'exact' || x.kind === 'relative');

	const range = $derived(isRange(value) ? value : ({ kind: 'named', range: 'past_week' } as DateRangeOperand));
	const rangeMode = $derived(range.kind === 'named' ? range.range : 'between');
	function pickRange(mode: string) {
		if (mode === 'between') onValue({ kind: 'between', from: { ...DEFAULT_RELATIVE, offset: -1 }, to: { ...DEFAULT_RELATIVE } }, true);
		else onValue({ kind: 'named', range: mode as NamedRange }, true);
	}

	const triggerClass = `${controlClass} inline-flex max-w-[220px] cursor-pointer items-center gap-1 text-left hover:bg-[color:var(--app-hover)]`;
</script>

<span class="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="filter-value" data-kind={kind}>
	{#if kind === 'none'}
		<!-- no value -->
	{:else if kind === 'text'}
		<input
			type="text"
			class="{controlClass} w-44"
			aria-label="Value"
			placeholder="Type a value…"
			disabled={readonly}
			value={typeof value === 'string' ? value : ''}
			oninput={(e) => onValue(e.currentTarget.value, false)}
		/>
	{:else if kind === 'number'}
		<input
			type="number"
			class="{controlClass} w-32"
			aria-label="Value"
			placeholder="Number"
			disabled={readonly}
			value={typeof value === 'number' ? value : ''}
			oninput={(e) => onValue(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value), false)}
		/>
	{:else if kind === 'boolean'}
		<select class={controlClass} aria-label="Value" disabled={readonly} value={value === false ? 'false' : 'true'} onchange={(e) => onValue(e.currentTarget.value === 'true', true)}>
			<option value="true">Checked</option>
			<option value="false">Unchecked</option>
		</select>
	{:else if kind === 'ref'}
		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open offset={4}>
			{#snippet trigger(popover)}
				<button type="button" class={triggerClass} disabled={readonly} aria-label="Value" aria-haspopup="dialog" data-testid="filter-ref" {@attach popover.trigger}>
					{#if option}
						<OptionTag color={optionColorName(option.color)} label={option.name} />
					{:else if personLike && refText}
						<span class="truncate">{person?.name ?? 'Someone'}</span>
					{:else if page}
						<span class="truncate">{page.icon ?? '📄'} {page.title || 'Untitled'}</span>
					{:else if refText && !optionLike && !personLike}
						<span class="truncate">Deleted page</span>
					{:else}
						<span class="text-[color:var(--app-text-tertiary)]">{personLike ? 'Select a person…' : optionLike ? 'Select an option…' : 'Select a page…'}</span>
					{/if}
				</button>
			{/snippet}
			{#snippet children(popover)}
				{#if def && optionLike}
					<SelectPicker
						{def}
						selected={refText ? [refText] : []}
						canEdit={false}
						onPick={(id) => {
							onValue(id, true);
							popover.close();
						}}
						onCreate={() => {}}
						onEditOptions={() => {}}
					/>
				{:else if personLike}
					{#if (op === 'contains' || op === 'not_contains') && onOp}
						<button
							type="button"
							class="flex w-full items-center px-3 text-left text-sm hover:bg-[color:var(--app-hover)]"
							style="height: var(--app-row-height)"
							data-testid="filter-me"
							onclick={() => {
								onOp(op === 'contains' ? 'is_me' : 'is_not_me');
								popover.close();
							}}>Me</button
						>
					{/if}
					<PersonPicker
						{members}
						selected={refText ? [refText] : []}
						onPick={(id) => {
							onValue(id, true);
							popover.close();
						}}
					/>
				{:else}
					<div class="w-[300px]">
						<PagePicker
							{store}
							placeholder="Link a page…"
							onpick={(id) => {
								onValue(id, true);
								popover.close();
							}}
						/>
					</div>
				{/if}
			{/snippet}
		</Popover>
	{:else if kind === 'date'}
		<DateOperandEditor value={isOperand(value) ? value : { ...DEFAULT_RELATIVE }} {readonly} onChange={(v) => onValue(v, true)} />
	{:else if kind === 'date_range'}
		<span class="inline-flex min-w-0 flex-wrap items-center gap-1">
			<select class={controlClass} aria-label="Range" data-testid="date-range-mode" disabled={readonly} value={rangeMode} onchange={(e) => pickRange(e.currentTarget.value)}>
				{#each NAMED_RANGE_CHOICES as r (r.range)}
					<option value={r.range}>{r.label}</option>
				{/each}
				<option value="between">Between…</option>
			</select>
			{#if range.kind === 'between'}
				<DateOperandEditor label="From" value={range.from} {readonly} onChange={(from) => onValue({ ...range, from }, true)} />
				<span class="text-sm text-[color:var(--app-text-tertiary)]">and</span>
				<DateOperandEditor label="To" value={range.to} {readonly} onChange={(to) => onValue({ ...range, to }, true)} />
			{/if}
		</span>
	{/if}
</span>
