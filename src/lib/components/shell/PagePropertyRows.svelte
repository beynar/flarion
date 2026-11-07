<script lang="ts">
	import { Avatar } from 'entasis/avatar';
	import { userCircleIcon } from 'entasis/icons/userCircle';
	import { circleDashedIcon } from 'entasis/icons/circleDashed';
	import { calendarBlankIcon } from 'entasis/icons/calendarBlank';
	import { tagIcon } from 'entasis/icons/tag';
	import { textTIcon } from 'entasis/icons/textT';
	import { checkSquareIcon } from 'entasis/icons/checkSquare';
	import { plusIcon } from 'entasis/icons/plus';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import type { Member } from '#lib/shared/schemas.ts';
	import type { PageEntity } from '#lib/client/workspace.svelte.ts';
	import OptionTag from './OptionTag.svelte';

	/** Read-only property rows (34px). The editors (Select, Date input, ...) replace these in P3. */
	let { page, properties, members }: { page: PageEntity; properties: readonly PropertyDef[]; members: readonly Member[] } = $props();

	const icons = {
		person: userCircleIcon,
		status: circleDashedIcon,
		date: calendarBlankIcon,
		select: tagIcon,
		multi_select: tagIcon,
		checkbox: checkSquareIcon
	} as Record<string, typeof tagIcon>;

	const rows = $derived(
		properties
			.filter((p) => p.type !== 'title')
			.map((def) => ({ def, value: page.values[def.id] ?? null }))
			.filter((r) => r.value !== null && !(Array.isArray(r.value) && r.value.length === 0) && r.value !== '')
	);

	function options(def: PropertyDef, value: unknown): { name: string; color: string }[] {
		const config = def.config as { options?: { id: string; name: string; color?: string }[] };
		const ids = Array.isArray(value) ? value : [value];
		return ids.map((id) => {
			const o = config.options?.find((x) => x.id === id);
			return { name: o?.name ?? String(id), color: !o?.color || o.color === 'default' ? 'gray' : o.color };
		});
	}
	const person = (id: string) => members.find((m) => m.userId === id)?.name ?? 'Someone';
	const dateText = (v: unknown) => {
		const d = v as { start?: string; end?: string | null };
		const fmt = (iso?: string | null) => (iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '');
		return d?.end ? `${fmt(d.start)} → ${fmt(d.end)}` : fmt(d?.start);
	};
</script>

{#if rows.length}
	<dl class="mb-2 flex flex-col pb-2" data-testid="page-properties">
		{#each rows as { def, value } (def.id)}
			<div class="flex items-center gap-2" style="min-height: var(--app-property-row-height)">
				<dt class="flex w-[140px] shrink-0 items-center gap-1.5 truncate px-1.5 text-sm text-[color:var(--app-text-secondary)] md:w-[160px]">
					{@render (icons[def.type] ?? textTIcon)({ size: 16 })}
					<span class="truncate">{def.name}</span>
				</dt>
				<dd class="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-1.5 text-sm">
					{#if def.type === 'person'}
						{#each Array.isArray(value) ? value : [value] as id (id)}
							<span class="inline-flex items-center gap-1.5">
								<Avatar size="small" name={person(String(id))} />
								<span class="truncate">{person(String(id))}</span>
							</span>
						{/each}
					{:else if def.type === 'status' || def.type === 'select' || def.type === 'multi_select'}
						{#each options(def, value) as o (o.name)}
							<OptionTag color={o.color} label={o.name} />
						{/each}
					{:else if def.type === 'date'}
						<span class="truncate">{dateText(value)}</span>
					{:else if def.type === 'checkbox'}
						<span>{value ? 'Yes' : 'No'}</span>
					{:else}
						<span class="truncate">{String(value)}</span>
					{/if}
				</dd>
			</div>
		{/each}
		<button
			class="mt-1 inline-flex w-fit items-center gap-1.5 rounded px-1.5 text-sm text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-hover)] disabled:cursor-not-allowed"
			style="height: var(--app-button-height)"
			disabled
			title="Property editors arrive in P3"
		>
			{@render plusIcon({ size: 14 })} Add a property
		</button>
	</dl>
{/if}
