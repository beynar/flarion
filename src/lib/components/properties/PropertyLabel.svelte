<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { trashIcon } from 'entasis/icons/trash';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import { NUMBER_FORMATS, typeLabel } from './helpers.ts';
	import { TYPE_ICONS } from './icons.ts';

	/**
	 * The label of a property row: icon and name. With edit access it opens a small menu to rename the
	 * property, change a number's format and delete the property from the whole workspace.
	 */
	let {
		def,
		editable,
		onRename,
		onConfig,
		onDelete
	}: {
		def: PropertyDef;
		editable: boolean;
		onRename: (name: string) => void;
		onConfig: (config: Record<string, unknown>) => void;
		onDelete: () => void;
	} = $props();

	let open = $state(false);
	let draft = $state('');
	let confirming = $state(false);
	const icon = $derived(TYPE_ICONS[def.type]);

	$effect(() => {
		if (open) {
			draft = def.name;
			confirming = false;
		}
	});

	function commit() {
		const t = draft.trim();
		if (t && t !== def.name) onRename(t);
	}
</script>

{#snippet body()}
	<span class="flex min-w-0 items-center gap-1.5">
		<span class="shrink-0">{@render icon({ size: 16 })}</span>
		<span class="truncate" data-testid="property-name">{def.name}</span>
	</span>
{/snippet}

<div class="w-[140px] shrink-0 md:w-[160px]">
	{#if editable}
		<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open offset={4}>
			{#snippet trigger(popover)}
				<button
					type="button"
					class="flex min-h-[28px] w-full min-w-0 items-center rounded-[var(--app-radius-control)] px-1.5 text-left text-sm text-[color:var(--app-text-secondary)] hover:bg-[color:var(--app-hover)]"
					aria-label={`Property ${def.name}`}
					{@attach popover.trigger}
				>
					{@render body()}
				</button>
			{/snippet}
			{#snippet children()}
				<div class="flex w-[240px] flex-col gap-1 p-2" data-testid="property-menu">
					<input
						class="rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm outline-none focus:border-[color:var(--app-accent)]"
						style="height: var(--app-input-height)"
						aria-label="Property name"
						bind:value={draft}
						onblur={commit}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								commit();
								open = false;
							}
						}}
					/>
					<div class="flex items-center gap-1.5 px-1 text-xs text-[color:var(--app-text-tertiary)]" style="height: var(--app-row-height)">
						{@render icon({ size: 14 })}
						{typeLabel(def.type)}
					</div>
					{#if def.type === 'number'}
						<label class="flex flex-col gap-1 px-1 text-xs text-[color:var(--app-text-tertiary)]">
							Number format
							<select
								class="rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-1.5 text-sm text-[color:var(--app-text)]"
								style="height: var(--app-input-height)"
								value={(def.config as { format?: string }).format ?? 'number'}
								onchange={(e) => onConfig({ ...def.config, format: e.currentTarget.value })}
							>
								{#each NUMBER_FORMATS as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
							</select>
						</label>
					{/if}
					<div class="my-1 border-t border-[color:var(--app-hairline)]"></div>
					<button
						type="button"
						class="flex items-center gap-1.5 rounded px-1.5 text-left text-sm text-[color:var(--app-danger)] hover:bg-[color:var(--app-hover)]"
						style="height: var(--app-row-height)"
						data-testid="delete-property"
						onclick={() => {
							if (!confirming) confirming = true;
							else {
								open = false;
								onDelete();
							}
						}}
					>
						{@render trashIcon({ size: 14 })}
						{confirming ? 'Click again to delete for everyone' : 'Delete property'}
					</button>
				</div>
			{/snippet}
		</Popover>
	{:else}
		<div class="flex min-h-[28px] items-center px-1.5 text-sm text-[color:var(--app-text-secondary)]">
			{@render body()}
		</div>
	{/if}
</div>
