<script lang="ts">
	import { clockIcon } from 'entasis/icons/clock';
	import { starIcon } from 'entasis/icons/star';
	import { goto } from '$app/navigation';
	import { Button } from 'entasis/button';
	import { notePencilIcon } from 'entasis/icons/notePencil';
	import { coverBackground } from '#lib/components/page-header/covers.ts';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import { page } from '$app/state';

	const store = useWorkspace();
	const ws = $derived(page.params.ws);

	const hour = new Date().getHours();
	const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

	// Recent and favorite pages are subscribed as one `page` subscription so their rows stay live.
	const recentIds = $derived(store.recent.map((r) => r.id).slice(0, 12));
	const wanted = $derived([...new Set([...recentIds, ...store.favorites])]);
	$effect(() => store.watchPages(wanted));

	const recentPages = $derived(
		store.recent
			.map((r) => ({ at: r.at, page: store.page(r.id) }))
			.filter((r): r is { at: number; page: NonNullable<typeof r.page> } => !!r.page)
			.slice(0, 4)
	);
	const favoritePages = $derived(store.favorites.map((id) => store.page(id)).filter((p): p is NonNullable<typeof p> => !!p));

	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	function ago(at: number): string {
		const s = Math.round((at - Date.now()) / 1000);
		const steps: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]];
		for (const [unit, size] of steps) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
		return 'Just now';
	}

	async function newPage() {
		try {
			await goto(`/${ws}/${await store.createPage({ parentId: null, teamspaceId: null })}`);
		} catch {
			// reported by the store
		}
	}
</script>

<svelte:head><title>Home · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pb-24 pt-10 md:px-[var(--app-page-padding-x)] md:pt-14"
>
	<h1 class="mb-10 text-center text-3xl font-semibold tracking-tight text-[color:var(--app-text)]">
		{greeting}, {store.user.name.split(' ')[0]}
	</h1>

	<section class="mb-10">
		<h2 class="mb-3 flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-text-tertiary)]">
			{@render clockIcon({ size: 14 })} Recently visited
		</h2>
		{#if recentPages.length}
			<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
				{#each recentPages as entry (entry.page.id)}
					<a
						href={`/${ws}/${entry.page.id}`}
						class="block overflow-hidden rounded-[var(--app-radius-panel)] border border-[color:var(--app-hairline)] bg-[color:var(--app-page)] text-[color:var(--app-text)] no-underline shadow-[var(--app-shadow-card)] transition-colors hover:bg-[color:var(--app-hover)]"
						data-testid="recent-card"
					>
						<div
							class="h-14 w-full bg-[color:var(--app-callout)] bg-cover bg-center"
							style:background-image={coverBackground(entry.page.cover)?.image}
						></div>
						<div class="flex flex-col gap-1 px-3 pb-3 pt-2">
							<span class="-mt-7 mb-1 text-2xl leading-none">{entry.page.icon ?? '📄'}</span>
							<span class="truncate text-sm font-medium">{entry.page.title || 'Untitled'}</span>
							<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{ago(entry.at)}</span>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="flex items-center gap-3 rounded-[var(--app-radius-panel)] border border-dashed border-[color:var(--app-hairline-strong)] px-4 py-5 text-sm text-[color:var(--app-text-secondary)]">
				<span class="flex-1">Pages you open show up here. Pick one from the sidebar or start a new one.</span>
				<Button size="small" prefix={notePencilIcon} disabled={!store.canEdit} onclick={newPage}>New page</Button>
			</div>
		{/if}
	</section>

	<section>
		<h2 class="mb-2 flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-text-tertiary)]">
			{@render starIcon({ size: 14 })} Favorites
		</h2>
		{#if favoritePages.length}
			<ul class="m-0 flex list-none flex-col p-0">
				{#each favoritePages as entry (entry.id)}
					<li>
						<a
							href={`/${ws}/${entry.id}`}
							class="flex items-center gap-2 rounded-[var(--app-radius-control)] px-2 text-sm text-[color:var(--app-text)] no-underline hover:bg-[color:var(--app-hover)]"
							style="height: var(--app-row-height)"
						>
							<span class="w-5 text-center">{entry.icon ?? '📄'}</span>
							<span class="flex-1 truncate">{entry.title || 'Untitled'}</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="m-0 px-2 text-sm text-[color:var(--app-text-tertiary)]">Star a page to keep it here.</p>
		{/if}
	</section>
</div>
