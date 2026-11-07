<script lang="ts">
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import { LEVELS } from '#lib/components/teamspaces/levels.ts';

	/** A compact access-level select (Full access, Can edit, Can comment, Can view). Native, so it is keyboard and test friendly. */
	let {
		value,
		label,
		disabled = false,
		onchange,
		testid = 'share-level',
		extra
	}: {
		value: AccessLevel;
		/** The accessible name, e.g. `Access level of Grace Hopper`. */
		label: string;
		disabled?: boolean;
		onchange: (level: AccessLevel) => void;
		testid?: string;
		/** Extra options appended after the four levels (for example "Remove"). */
		extra?: { value: string; label: string }[];
	} = $props();
</script>

<select
	class="level-select"
	aria-label={label}
	data-testid={testid}
	{disabled}
	{value}
	onchange={(e) => {
		const next = e.currentTarget.value;
		if (LEVELS.some((l) => l.value === next)) onchange(next as AccessLevel);
	}}
>
	{#each LEVELS as l (l.value)}<option value={l.value}>{l.label}</option>{/each}
	{#each extra ?? [] as x (x.value)}<option value={x.value}>{x.label}</option>{/each}
</select>

<style>
	.level-select {
		height: var(--app-button-height-small);
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: var(--app-radius-control);
		background: transparent;
		color: var(--app-text-secondary);
		font-size: var(--app-font-size-small);
		cursor: pointer;
	}
	.level-select:hover:not(:disabled) {
		background: var(--app-hover);
	}
	.level-select:disabled {
		cursor: default;
		opacity: 0.8;
		appearance: none;
		-webkit-appearance: none;
		padding-right: 0;
	}
	.level-select:focus-visible {
		outline: 2px solid var(--app-accent);
		outline-offset: 1px;
	}
</style>
