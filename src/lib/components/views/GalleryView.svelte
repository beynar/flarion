<!--
	The gallery layout: entasis Grid of Cards. The cover is the chosen files property or the page's cover; the
	card size is a view option (small, medium, large). Cards show the title and the shown properties.
-->
<script lang="ts">
	import { Grid } from 'entasis/grid';
	import { Card } from 'entasis/card';
	import { plusIcon } from 'entasis/icons/plus';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import type { ViewEnv } from './env.ts';
	import CardProps from './CardProps.svelte';
	import Cover from './Cover.svelte';
	import { optionsOfView } from './view-model.ts';

	let { env, data }: { env: ViewEnv; data: ViewData } = $props();

	const size = $derived(optionsOfView(env.view).cardSize ?? 'medium');
	const min = $derived(size === 'small' ? 170 : size === 'large' ? 340 : 240);
	const coverHeight = $derived(size === 'small' ? 90 : size === 'large' ? 200 : 140);
	let infinite = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = infinite;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && env.loadMore());
		io.observe(el);
		return () => io.disconnect();
	});
</script>

<div class="gallery" data-testid="view-gallery" data-size={size}>
	<Grid columns={{ minWidth: min }} gap="md">
		{#each data.rows as row (row.id)}
			{@const cover = env.cover(row)}
			<Card
				variant="outline"
				density="compact"
				href={env.href(row.id)}
				onclick={(e: MouseEvent) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
					e.preventDefault();
					env.open(row.id, e);
				}}
				theme={{ root: { base: 'group/card text-neutral flex flex-col rounded-[6px] overflow-hidden py-0! gap-0! ring-0! bg-[color:var(--app-page)] hover:bg-[color:var(--app-hover)] shadow-[0_0_0_1px_var(--app-hairline)]' }, content: { base: 'p-0! px-0!' } }}
			>
				<div class="card" data-testid="gallery-card" data-row-id={row.id}>
					<Cover {cover} height={coverHeight} />
					<div class="body">
						<div class="ctitle" class:placeholder={!row.title}>
							{#if row.icon}<span aria-hidden="true">{row.icon}</span>{/if}
							<span data-testid="view-row-title">{row.title || 'Untitled'}</span>
						</div>
						<CardProps {env} {row} />
					</div>
				</div>
			</Card>
		{/each}
	</Grid>
	{#if data.rows.length === 0}<div class="none" data-testid="view-empty">No pages yet</div>{/if}
	{#if data.rows.length < data.total}<div bind:this={infinite} class="sentinel"></div>{/if}
	<div class="foot">
		{#if env.editable}
			<button type="button" class="add" data-testid="view-add-row" onclick={() => void env.newRow()}>{@render plusIcon({ size: 14 })} New page</button>
		{/if}
		<span class="count" data-testid="view-count">{data.total} {data.total === 1 ? 'page' : 'pages'}</span>
	</div>
</div>

<style>
	.gallery {
		padding-top: 12px;
		min-width: 0;
	}
	.card {
		display: flex;
		flex-direction: column;
		width: 100%;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px 12px;
	}
	.ctitle {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		font-weight: 500;
		word-break: break-word;
	}
	.ctitle.placeholder {
		color: var(--app-text-tertiary);
		font-weight: 400;
	}
	.none {
		padding: 12px 6px;
		color: var(--app-text-secondary);
	}
	.sentinel {
		height: 1px;
	}
	.foot {
		display: flex;
		align-items: center;
		min-height: 34px;
		margin-top: 8px;
		font-size: 13px;
		color: var(--app-text-secondary);
	}
	.add {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		cursor: pointer;
	}
	.add:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.count {
		margin-left: auto;
		font-size: 12px;
	}
</style>
