<script lang="ts">
	import FlarionLogo from '#lib/components/shell/FlarionLogo.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.title} · Flarion</title>
	<!-- Published pages are never indexed (the X-Robots-Tag header says the same). -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<!-- Published page, read-only. P4 renders the body here from the room's read() and edytor/export, cached in KV. -->
<header
	class="flex items-center gap-2 px-4 text-sm text-[color:var(--app-text-secondary)]"
	style="height: var(--app-topbar-height)"
>
	<FlarionLogo size={18} />
	<span class="font-medium text-[color:var(--app-text)]">{data.title}</span>
	<span class="flex-1"></span>
	<a
		href="/signup"
		class="rounded px-2 text-[color:var(--app-accent)] no-underline hover:bg-[color:var(--app-hover)]"
		style="line-height: var(--app-button-height)">Try Flarion</a
	>
</header>

<article
	class="mx-auto w-full px-[var(--app-page-padding-x-narrow)] pt-16 pb-32 md:px-[var(--app-page-padding-x)]"
	style="max-width: calc(var(--app-page-width) + 2 * var(--app-page-padding-x));"
	data-testid="shared-page"
>
	{#if data.icon}
		<div class="text-[78px] leading-none" role="img" aria-label="Page icon">{data.icon}</div>
	{/if}
	<h1 class="mt-2 mb-6 font-bold" style="font-size: var(--app-font-size-title); line-height: 1.2">
		{data.title}
	</h1>
	<p class="text-sm text-[color:var(--app-text-secondary)]">The content of this page will appear here soon.</p>
</article>
