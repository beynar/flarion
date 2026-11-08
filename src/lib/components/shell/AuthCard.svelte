<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Card } from 'entasis/card';
	// Importing it applies the saved (or the OS's) contrast choice to the page.
	import '#lib/client/a11y.svelte.ts';
	import FlarionLogo from './FlarionLogo.svelte';

	let {
		heading,
		lede,
		children,
		after
	}: {
		heading: string;
		lede?: string;
		children: Snippet;
		after?: Snippet;
	} = $props();
</script>

<main class="auth-main flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
	<a
		href="/"
		class="flex items-center gap-2 text-[color:var(--app-text)] no-underline"
		aria-label="Flarion home"
	>
		<FlarionLogo size={28} />
		<span class="text-xl font-semibold tracking-tight">Flarion</span>
	</a>

	<Card
		variant="outline"
		density="comfortable"
		class="w-full max-w-[400px] rounded-[var(--app-radius-panel)]"
	>
		{#snippet title()}
			<h1 class="text-xl leading-snug font-semibold">{heading}</h1>
		{/snippet}
		{#snippet description()}
			{#if lede}{lede}{/if}
		{/snippet}
		{@render children()}
		{#snippet footer()}
			{#if after}{@render after()}{/if}
		{/snippet}
	</Card>
</main>

<style>
	/* A link inside a sentence must not rely on its color alone (WCAG 1.4.1): underline them. The logo link has a label. */
	.auth-main :global(a:not([aria-label])) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
