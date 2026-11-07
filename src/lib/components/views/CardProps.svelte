<!--
	The shown properties of a row as compact values (cards, list rows): empty ones are left out. Read only; edit a
	value in the table or on the page.
-->
<script lang="ts">
	import PropertyValue from '#lib/components/properties/PropertyValue.svelte';
	import { isEmpty } from '#lib/components/properties/helpers.ts';
	import { TITLE_PROP_ID } from '#lib/shared/property-types.ts';
	import type { ViewRow } from '#lib/shared/protocol.ts';
	import type { ViewEnv } from './env.ts';

	let { env, row, skip = [], inline = false }: { env: ViewEnv; row: ViewRow; skip?: string[]; inline?: boolean } = $props();

	const cells = $derived(
		env.columns
			.filter((c) => c.def.id !== TITLE_PROP_ID && !skip.includes(c.def.id))
			.map((c) => ({ def: c.def, value: row.values[c.def.id] ?? null }))
			.filter((c) => !isEmpty(c.def, c.value))
	);
</script>

{#if cells.length}
	<div class="props" class:inline data-testid="card-props">
		{#each cells as cell (cell.def.id)}
			<div class="prop" data-prop={cell.def.id}>
				<PropertyValue def={cell.def} value={cell.value} compact {...env.lookups} />
			</div>
		{/each}
	</div>
{/if}

<style>
	.props {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.props.inline {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
	}
	.prop {
		min-width: 0;
		font-size: 13px;
		color: var(--app-text-secondary);
	}
</style>
