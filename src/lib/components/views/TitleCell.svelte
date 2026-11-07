<!--
	The title of a row: its icon and name, edited in place by a click, with an "Open" chip on hover that opens the
	page. An empty title shows "Untitled". A new row (`autofocus`) starts in edit mode, as in Notion.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { arrowsOutSimpleIcon } from 'entasis/icons/arrowsOutSimple';
	import type { ViewRow } from '#lib/shared/protocol.ts';
	import type { ViewEnv } from './env.ts';

	let {
		env,
		row,
		autofocus = false,
		onFocused,
		wrap = false
	}: { env: ViewEnv; row: ViewRow; autofocus?: boolean; onFocused?: () => void; wrap?: boolean } = $props();

	const canEdit = $derived(env.editable && row.access !== 'read' && row.access !== 'comment');
	let editing = $state(false);
	let draft = $state('');
	let input = $state<HTMLInputElement>();

	async function start() {
		if (!canEdit) return;
		draft = row.title;
		editing = true;
		await tick();
		input?.focus();
		input?.select();
	}
	function commit() {
		if (!editing) return;
		editing = false;
		const next = draft.trim();
		if (next !== row.title) env.setTitle(row.id, next);
	}

	$effect(() => {
		if (autofocus && canEdit) {
			onFocused?.();
			void start();
		}
	});
</script>

<div class="title" data-testid="title-cell">
	{#if row.icon}<span class="icon" aria-hidden="true">{row.icon}</span>{/if}
	{#if editing}
		<input
			bind:this={input}
			class="edit"
			aria-label="Title"
			data-testid="title-input"
			bind:value={draft}
			onblur={commit}
			onkeydown={(e) => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					e.preventDefault();
					commit();
				} else if (e.key === 'Escape') {
					editing = false;
				}
			}}
		/>
	{:else}
		<span
			class="text"
			class:placeholder={!row.title}
			class:wrap
			role="button"
			tabindex="0"
			data-testid="view-row-title"
			onclick={() => void start()}
			onkeydown={(e) => {
				if (e.key === 'Enter' && canEdit) {
					e.preventDefault();
					void start();
				}
			}}>{row.title || 'Untitled'}</span
		>
		<a
			class="open"
			href={env.href(row.id)}
			data-testid="view-row-open"
			aria-label="Open {row.title || 'Untitled'}"
			onclick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				env.open(row.id, e);
			}}
		>
			{@render arrowsOutSimpleIcon({ size: 12 })} Open
		</a>
	{/if}
</div>

<style>
	.title {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		width: 100%;
		position: relative;
	}
	.icon {
		flex-shrink: 0;
		font-size: 15px;
		line-height: 1;
	}
	.text {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		cursor: text;
	}
	.text.wrap {
		white-space: normal;
		overflow: visible;
	}
	.text.placeholder {
		color: var(--app-text-tertiary);
		font-weight: 400;
	}
	.edit {
		flex: 1;
		min-width: 0;
		height: 26px;
		padding: 0 4px;
		border: 1px solid var(--app-accent);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		font: inherit;
		font-weight: 500;
		outline: none;
	}
	.open {
		display: none;
		flex-shrink: 0;
		align-items: center;
		gap: 3px;
		height: 22px;
		padding: 0 6px;
		border: 1px solid var(--app-hairline-strong);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text-secondary);
		font-size: 12px;
		text-decoration: none;
		box-shadow: 0 1px 2px rgba(15, 15, 15, 0.08);
	}
	.open:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.title:hover .open,
	.open:focus-visible {
		display: inline-flex;
	}
</style>
