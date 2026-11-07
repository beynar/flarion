<!--
	The title of a row: its icon and name, edited in place by a click, with an "Open" chip on hover that opens the
	page. An empty title shows "Untitled". A new row (`autofocus`) starts in edit mode, as in Notion.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
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
	let editor = $state<HTMLElement>();

	async function start() {
		if (!canEdit) return;
		draft = row.title;
		editing = true;
		await tick();
		const input = editor?.querySelector('input');
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

<div class="title group/title" data-testid="title-cell">
	{#if row.icon}<span class="icon" aria-hidden="true">{row.icon}</span>{/if}
	{#if editing}
		<div class="edit" bind:this={editor} data-testid="title-editor">
			<TextInput
				size="small"
				value={draft}
				onValueChange={(v) => (draft = v ?? '')}
				inputAttrs={{
					'aria-label': 'Title',
					'data-testid': 'title-input',
					onblur: commit,
					onkeydown: (e) => {
						e.stopPropagation();
						if (e.key === 'Enter') {
							e.preventDefault();
							commit();
						} else if (e.key === 'Escape') {
							editing = false;
						}
					}
				}}
			/>
		</div>
	{:else}
		<!-- Click-to-edit title: entasis has no inline-edit display component (the edit field itself is a TextInput). -->
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
		<Button
			variant="outline"
			size="small"
			href={env.href(row.id)}
			label="Open {row.title || 'Untitled'}"
			prefix={arrowsOutSimpleIcon}
			data-testid="view-row-open"
			class="absolute! right-0 h-[22px]! opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100"
			onclick={(e: MouseEvent) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				env.open(row.id, e);
			}}
		>
			Open
		</Button>
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
	}
</style>
