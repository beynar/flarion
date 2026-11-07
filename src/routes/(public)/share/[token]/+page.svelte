<script lang="ts">
	import { page } from '$app/state';
	import FlarionLogo from '#lib/components/shell/FlarionLogo.svelte';
	import { sharedPage } from '#lib/client/mock.ts';
</script>

<svelte:head>
	<title>{sharedPage.title} · Flarion</title>
</svelte:head>

<!-- Published page, read-only. The real route renders server HTML from the room's read() and
     edytor/export, cached in KV; this static page stands in for it. -->
<header
	class="flex items-center gap-2 px-4 text-sm text-[color:var(--app-text-secondary)]"
	style="height: var(--app-topbar-height)"
>
	<FlarionLogo size={18} />
	<span class="font-medium text-[color:var(--app-text)]">{sharedPage.title}</span>
	<span class="flex-1"></span>
	<span class="hidden md:inline">Published {sharedPage.publishedAt}</span>
	<a
		href="/signup"
		class="rounded px-2 text-[color:var(--app-accent)] no-underline hover:bg-[color:var(--app-hover)]"
		style="line-height: var(--app-button-height)">Try Flarion</a
	>
</header>

<article
	class="mx-auto w-full px-[var(--app-page-padding-x-narrow)] pt-16 pb-32 md:px-[var(--app-page-padding-x)]"
	style="max-width: calc(var(--app-page-width) + 2 * var(--app-page-padding-x));"
	data-share-token={page.params.token}
>
	<div class="text-[78px] leading-none" role="img" aria-label="Page icon">{sharedPage.icon}</div>
	<h1 class="mt-2 mb-6 font-bold" style="font-size: var(--app-font-size-title); line-height: 1.2">
		{sharedPage.title}
	</h1>

	<div data-edytor>
		{#each sharedPage.blocks as block, index (index)}
			{#if block.kind === 'heading'}
				<div data-edytor-block data-edytor-type="heading"><h2>{block.text}</h2></div>
			{:else if block.kind === 'bullet'}
				<div data-edytor-block data-edytor-type="bulleted-list-item">
					<div><p>{block.text}</p></div>
				</div>
			{:else}
				<div data-edytor-block data-edytor-type="paragraph"><p>{block.text}</p></div>
			{/if}
		{/each}
	</div>
</article>
