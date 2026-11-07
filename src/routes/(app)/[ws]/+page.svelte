<script lang="ts">
	import { page } from '$app/state';
	import { clockIcon } from 'entasis/icons/clock';
	import { starIcon } from 'entasis/icons/star';
	import { covers, favoritePages, recentPages, user } from '#lib/client/mock.ts';

	const ws = $derived(page.params.ws);
	const hour = new Date().getHours();
	const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
</script>

<svelte:head><title>Home · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pb-24 pt-10 md:px-[var(--app-page-padding-x)] md:pt-14"
>
	<h1 class="mb-10 text-center text-3xl font-semibold tracking-tight text-[color:var(--app-text)]">
		{greeting}, {user.name.split(' ')[0]}
	</h1>

	<section class="mb-10">
		<h2
			class="mb-3 flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-text-tertiary)]"
		>
			{@render clockIcon({ size: 14 })} Recently visited
		</h2>
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each recentPages.slice(0, 4) as entry (entry.slug)}
				<a
					href={`/${ws}/${entry.slug}`}
					class="block overflow-hidden rounded-[var(--app-radius-panel)] border border-[color:var(--app-hairline)] bg-[color:var(--app-page)] text-[color:var(--app-text)] no-underline shadow-[var(--app-shadow-card)] transition-colors hover:bg-[color:var(--app-hover)]"
				>
					<div
						class="h-14 w-full bg-[color:var(--app-callout)]"
						style:background={entry.cover ? covers[entry.cover] : undefined}
					></div>
					<div class="flex flex-col gap-1 px-3 pb-3 pt-2">
						<span class="-mt-7 mb-1 text-2xl leading-none">{entry.icon}</span>
						<span class="truncate text-sm font-medium">{entry.title}</span>
						<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">
							{entry.visitedAt}
						</span>
					</div>
				</a>
			{/each}
		</div>
	</section>

	<section>
		<h2
			class="mb-2 flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-text-tertiary)]"
		>
			{@render starIcon({ size: 14 })} Favorites
		</h2>
		<ul class="flex flex-col">
			{#each favoritePages as entry (entry.slug)}
				<li>
					<a
						href={`/${ws}/${entry.slug}`}
						class="flex items-center gap-2 rounded-[var(--app-radius-control)] px-2 text-sm text-[color:var(--app-text)] no-underline hover:bg-[color:var(--app-hover)]"
						style="height: var(--app-row-height)"
					>
						<span class="w-5 text-center">{entry.icon}</span>
						<span class="flex-1 truncate">{entry.title}</span>
						<span class="text-xs text-[color:var(--app-text-tertiary)]">{entry.editedBy}</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
</div>
