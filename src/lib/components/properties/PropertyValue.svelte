<script lang="ts">
	import { Avatar, AvatarGroup } from 'entasis/avatar';
	import { Checkbox } from 'entasis/checkbox';
	import { Chip } from 'entasis/chip';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { paperclipIcon } from 'entasis/icons/paperclip';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import { isDateValue, type PropValue, type PropertyDef } from '#lib/shared/property-types.ts';
	import {
		findOption,
		formatDateValue,
		formatNumber,
		formatUniqueId,
		hrefFor,
		optionColorName,
		valueIds,
		type NumberConfig
	} from './helpers.ts';
	import type { PropertyLookups } from './types.ts';

	/**
	 * The read-only cell of one property value: the page header's value column, a table cell, a board
	 * card line. Controlled, with no store: ids become labels through `members`, `resolvePage` and
	 * `fileInfo`. `compact` shows people as an avatar stack and drops the empty-state placeholder.
	 */
	let {
		def,
		value,
		members,
		resolvePage,
		fileInfo,
		pageHref,
		compact = false
	}: { def: PropertyDef; value: PropValue | null | undefined; compact?: boolean } & PropertyLookups = $props();

	const person = (id: string) => members.find((m) => m.userId === id)?.name ?? 'Deleted user';
	const ids = $derived(valueIds(value));
	// An option the registry does not know (deleted, or created elsewhere and not fetched yet) shows nothing.
	const tags = $derived(
		def.type === 'select' || def.type === 'status' || def.type === 'multi_select'
			? ids.flatMap((id) => {
					const o = findOption(def, id);
					return o ? [{ id, name: o.name, color: optionColorName(o.color) }] : [];
				})
			: []
	);
	const isOptionProp = $derived(def.type === 'select' || def.type === 'status' || def.type === 'multi_select');
	const text = $derived.by(() => {
		if (value === null || value === undefined || value === '') return '';
		switch (def.type) {
			case 'number':
				return typeof value === 'number' ? formatNumber(value, def.config as NumberConfig) : String(value);
			case 'unique_id':
				return typeof value === 'number' ? formatUniqueId((def.config as { prefix?: string }).prefix, value) : String(value);
			case 'created_time':
			case 'last_edited_time':
				return typeof value === 'string' ? formatDateValue({ start: value }) : '';
			case 'date':
				return isDateValue(value) ? formatDateValue(value) : '';
			case 'formula':
			case 'rollup':
				if (isDateValue(value)) return formatDateValue(value);
				if (typeof value === 'boolean') return value ? 'Yes' : 'No';
				if (typeof value === 'number') return formatNumber(value);
				return Array.isArray(value) ? value.join(', ') : String(value);
			default:
				return Array.isArray(value) ? value.join(', ') : isDateValue(value) ? formatDateValue(value) : String(value);
		}
	});
	const href = $derived(def.type === 'url' || def.type === 'email' || def.type === 'phone' ? hrefFor(def.type, typeof value === 'string' ? value : null) : null);
	const empty = $derived(
		def.type === 'checkbox' ? value === null || value === undefined : isOptionProp ? tags.length === 0 : ids.length === 0 && text === '' && !(typeof value === 'boolean')
	);
	const checked = $derived(value === true);
</script>

<span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm" data-type={def.type}>
	{#if def.type === 'checkbox' || ((def.type === 'formula' || def.type === 'rollup') && typeof value === 'boolean')}
		<!-- A display, not a control: read-only and out of the tab order. -->
		<Checkbox size="small" value={checked} readOnly inputAttrs={{ 'aria-label': checked ? 'Checked' : 'Unchecked', tabindex: -1 }} />
	{:else if empty}
		{#if !compact}<span class="text-[color:var(--app-text-tertiary)]">Empty</span>{/if}
	{:else if tags.length}
		{#each tags as t (t.id)}
			<OptionTag color={t.color} label={t.name} />
		{/each}
	{:else if def.type === 'person' || def.type === 'created_by' || def.type === 'last_edited_by'}
		{#if compact && ids.length > 1}
			<AvatarGroup items={ids.map((id) => ({ name: person(id) }))} max={4} size="small" />
		{:else}
			{#each ids as id (id)}
				<span class="inline-flex min-w-0 items-center gap-1.5">
					<Avatar size="small" name={person(id)} />
					{#if !compact || ids.length === 1}<span class="truncate">{person(id)}</span>{/if}
				</span>
			{/each}
		{/if}
	{:else if def.type === 'relation'}
		{#each ids as id (id)}
			{@const p = resolvePage?.(id)}
			{@const link = p ? pageHref?.(id) : undefined}
			<svelte:element
				this={link ? 'a' : 'span'}
				href={link}
				class="inline-flex min-w-0 max-w-full items-center gap-1 text-[color:var(--app-text)] {link ? 'underline decoration-[color:var(--app-hairline-strong)] underline-offset-2' : ''}"
				data-testid="relation-chip"
			>
				<span class="shrink-0 text-[13px] leading-none">{#if p?.icon}{p.icon}{:else}{@render fileTextIcon({ size: 14 })}{/if}</span>
				<span class="truncate">{p ? p.title || 'Untitled' : 'Deleted page'}</span>
			</svelte:element>
		{/each}
	{:else if def.type === 'files'}
		{#each ids as id (id)}
			{@const f = fileInfo?.(id)}
			<Chip
				variant="soft"
				color="neutral"
				size="small"
				href={f?.url}
				target={f?.url ? '_blank' : undefined}
				rel={f?.url ? 'noopener noreferrer' : undefined}
				theme={{ root: { base: 'h-[var(--app-tag-height)]! max-w-full! rounded-[3px]! px-1.5! text-sm! font-normal! text-[color:var(--app-text)]! no-underline' } }}
				data-testid="file-chip"
			>
				{#snippet prefix()}{@render paperclipIcon({ size: 12 })}{/snippet}
				<span class="truncate">{f?.name ?? 'File'}</span>
			</Chip>
		{/each}
	{:else if href}
		<a
			{href}
			target={def.type === 'url' ? '_blank' : undefined}
			rel="noopener noreferrer"
			class="min-w-0 truncate text-[color:var(--app-text)] underline decoration-[color:var(--app-hairline-strong)] underline-offset-2 hover:decoration-current"
			onclick={(e) => e.stopPropagation()}>{text}</a
		>
	{:else}
		<span class="min-w-0 {def.type === 'text' || def.type === 'ai' ? 'whitespace-pre-wrap break-words' : 'truncate'}">{text}</span>
	{/if}
</span>
