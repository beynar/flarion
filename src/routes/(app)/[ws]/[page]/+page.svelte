<script lang="ts">
	import { page } from '$app/state';
	import { getPage, workspace } from '#lib/client/mock.ts';
	import DocumentPlaceholder from '#lib/components/shell/DocumentPlaceholder.svelte';
	import PageHeader from '#lib/components/shell/PageHeader.svelte';

	const current = $derived(getPage(page.params.page ?? ''));
</script>

<svelte:head><title>{current ? current.title : 'Not found'} · Flarion</title></svelte:head>

{#if current}
	{#key current.slug}
		<PageHeader page={current} />
		<DocumentPlaceholder />
	{/key}
{:else}
	<div class="mx-auto mt-24 flex max-w-[420px] flex-col items-center gap-2 px-6 text-center">
		<div class="text-5xl">🔎</div>
		<h1 class="text-xl font-semibold">This page doesn't exist</h1>
		<p class="text-sm text-[color:var(--app-text-secondary)]">
			It may have been moved to the trash, or you may not have access.
		</p>
		<a href={`/${page.params.ws ?? workspace.slug}`} class="text-sm text-[color:var(--app-accent)]">
			Back to home
		</a>
	</div>
{/if}
