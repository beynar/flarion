<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Card } from 'entasis/card';
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

<main class="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
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
