<!--
	The body of a `breadcrumb` block: the ancestors of the page it sits on, read from the workspace store through
	the editor context (`resolveAncestors`), as links. Reactive: a rename or a move up the tree shows at once.
-->
<script lang="ts">
	import { getEditorContext } from '../context.ts';

	const ctx = getEditorContext();
	const ancestors = $derived(ctx?.resolveAncestors?.(ctx.pageId) ?? []);

	function open(event: MouseEvent, id: string) {
		if (!ctx?.open || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		ctx.open(id, { newTab: false });
	}
</script>

<nav class="crumbs" aria-label="Breadcrumb" data-testid="breadcrumb">
	{#each ancestors as ancestor (ancestor.id)}
		<a href={ctx?.href(ancestor.id)} onclick={(event) => open(event, ancestor.id)} data-testid="breadcrumb-item">
			{#if ancestor.icon}<span aria-hidden="true">{ancestor.icon}</span>{/if}
			<span>{ancestor.title || 'Untitled'}</span>
		</a>
		<span class="sep" aria-hidden="true">/</span>
	{/each}
	<span class="current" aria-current="page" data-testid="breadcrumb-current">
		{#if ctx?.resolvePage?.(ctx.pageId)?.icon}<span aria-hidden="true">{ctx.resolvePage(ctx.pageId)?.icon}</span>{/if}
		<span>{ctx?.resolvePage?.(ctx.pageId)?.title || 'Untitled'}</span>
	</span>
</nav>

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin: 4px 0;
		padding: 4px 2px;
		font-size: 14px;
		color: var(--app-text-secondary);
	}
	a {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 4px;
		border-radius: var(--app-radius-control);
		color: inherit;
		text-decoration: none;
	}
	a:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.sep {
		opacity: 0.5;
	}
	.current {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 4px;
		color: var(--app-text);
	}
</style>
