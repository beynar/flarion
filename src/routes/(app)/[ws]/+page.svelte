<script lang="ts">
	import { clockIcon } from 'entasis/icons/clock';
	import { starIcon } from 'entasis/icons/star';
	import { goto } from '$app/navigation';
	import { Card } from 'entasis/card';
	import { Empty } from 'entasis/empty';
	import { Menu, type MenuItem } from 'entasis/menu';
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

	const favoriteItems = $derived<MenuItem[]>(
		favoritePages.map((entry) => ({
			type: 'option' as const,
			title: entry.title || 'Untitled',
			prefix: entry.icon ?? '📄',
			href: `/${ws}/${entry.id}`,
			'data-testid': 'favorite-row'
		})) as MenuItem[]
	);

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
					<Card
						variant="outline"
						density="compact"
						href={`/${ws}/${entry.page.id}`}
						theme={{ root: { base: 'group/card flex flex-col rounded-[var(--app-radius-panel)] overflow-hidden py-0! gap-0! ring-0! bg-[color:var(--app-page)] text-[color:var(--app-text)] no-underline shadow-[var(--app-shadow-card),0_0_0_1px_var(--app-hairline)] hover:bg-[color:var(--app-hover)]' }, content: { base: 'p-0! px-0!' } }}
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
					</Card>
				{/each}
			</div>
		{:else}
			<Empty
				bordered
				size="small"
				title="No recent pages"
				description="Pages you open show up here. Pick one from the sidebar or start a new one."
				actions={[{ content: 'New page', prefix: notePencilIcon, disabled: !store.canEdit, onclick: newPage }]}
			/>
		{/if}
	</section>

	<section>
		<h2 class="mb-2 flex items-center gap-1.5 text-xs font-medium text-[color:var(--app-text-tertiary)]">
			{@render starIcon({ size: 14 })} Favorites
		</h2>
		{#if favoritePages.length}
			<Menu items={favoriteItems} />
		{:else}
			<Empty size="small" description="Star a page to keep it here." />
		{/if}
	</section>
</div>
