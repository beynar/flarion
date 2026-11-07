<script lang="ts">
	import { goto } from '$app/navigation';
	import { page as route } from '$app/state';
	import Editor from '#lib/components/editor/Editor.svelte';
	import { createCoverUploader } from '#lib/components/editor/uploads.ts';
	import PageHeader from '#lib/components/page-header/PageHeader.svelte';
	import type { PageHeaderAccess } from '#lib/components/page-header/types.ts';
	import { rpc } from '#lib/client/rpc.ts';
	import { isMock, userColor } from '#lib/client/runtime.ts';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import DocumentPlaceholder from '#lib/components/shell/DocumentPlaceholder.svelte';
	import PropertiesPanel from '#lib/components/properties/PropertiesPanel.svelte';

	const store = useWorkspace();
	const ws = $derived(route.params.ws ?? store.workspace.slug);
	const pageId = $derived(route.params.page ?? '');
	const entity = $derived(store.page(pageId));
	const status = $derived(store.pageStatus(pageId));
	// The page's subscription answered and has no row for it: it does not exist, was trashed, or access was withdrawn
	// (a revoked grant removes the row live). Without this the skeleton would stay forever.
	const unavailable = $derived(!entity && (status === 'error' || status === 'ready'));
	const backlinks = $derived(store.backlinks(pageId));

	// Subscribe to the page and its backlinks, publish presence, and unfold the tree to it.
	$effect(() => {
		const id = pageId;
		if (!id) return;
		const release = store.openPage(id);
		store.setPresence(id);
		return () => {
			release();
			store.setPresence(null);
			void store.flushTitles();
		};
	});
	$effect(() => {
		if (pageId) store.reveal(pageId);
	});

	// The header calls the protocol's `update` level "write".
	const headerAccess = $derived<PageHeaderAccess>(entity?.access === 'update' ? 'write' : (entity?.access ?? 'read'));
	const readonly = $derived(!entity || entity.access === 'read' || entity.access === 'comment');
	const me = $derived({ id: store.user.id, name: store.user.name, color: userColor(store.user.id) });
	// Mock mode has no page rooms: the static document stands in for the editor.
	const mock = isMock();

	const guard = <T,>(p: Promise<T>) => p.catch(() => undefined);
	// Covers and inline images go through the files flow (R2); databases are what a linked view can point at.
	const uploadCover = $derived(createCoverUploader({ workspaceId: store.workspace.id, pageId, rpc }));
	const searchDatabases = (q: string) =>
		[...store.pages.values()]
			.filter((p) => p.isDatabase && (p.title || 'Untitled').toLowerCase().includes(q.trim().toLowerCase()))
			.slice(0, 20)
			.map((p) => ({ id: p.id, title: p.title, icon: p.icon }));
</script>

<svelte:head><title>{entity ? entity.title || 'Untitled' : unavailable ? 'Not found' : 'Flarion'} · Flarion</title></svelte:head>

{#if entity}
	{#key pageId}
		<PageHeader
			page={{ id: entity.id, title: entity.title, icon: entity.icon, cover: entity.cover }}
			access={headerAccess}
			backlinks={backlinks.length}
			presence={store.othersOn(pageId)}
			onTitle={(title) => store.setTitle(pageId, title)}
			onIcon={(icon) => guard(store.setPage(pageId, { icon }))}
			onCover={(cover) => guard(store.setPage(pageId, { cover }))}
			{uploadCover}
		>
			{#snippet properties()}
				<PropertiesPanel {store} page={entity} />
			{/snippet}
		</PageHeader>

		{#if mock}
			<DocumentPlaceholder />
		{:else}
			<Editor
				workspaceId={store.workspace.id}
				{pageId}
				getRoomToken={() => rpc.page.roomToken({ id: pageId })}
				user={me}
				{readonly}
				access={entity?.access}
				onSubpage={async ({ parentId, title }) => ({ id: await store.createPage({ parentId, title }) })}
				resolvePage={(id) => {
					const p = store.resolvePage(id);
					return p ? { title: p.title, icon: p.icon } : undefined;
				}}
				resolveAncestors={(id) => store.ancestors(id)}
				{searchDatabases}
				searchPages={async (q) => store.searchPages(q)}
				searchPeople={async (q) => store.searchPeople(q).map((m) => ({ id: m.id, name: m.name }))}
				resolvePerson={(id) => store.members.find((m) => m.userId === id)}
				onNavigate={(id) => goto(`/${ws}/${id}`)}
			/>
		{/if}
	{/key}
{:else if unavailable}
	<div class="mx-auto mt-24 flex max-w-[420px] flex-col items-center gap-2 px-6 text-center" role="alert" data-testid="page-unavailable">
		<div class="text-5xl">🔎</div>
		<h1 class="text-xl font-semibold">This page doesn't exist</h1>
		<p class="text-sm text-[color:var(--app-text-secondary)]">
			It may have been moved to the trash, or you may not have access.
		</p>
		<a href={`/${ws}`} class="text-sm text-[color:var(--app-accent)]">Back to home</a>
	</div>
{:else}
	<div class="mx-auto w-full max-w-[var(--app-page-width)] px-[var(--app-page-padding-x-narrow)] pt-24 md:px-[var(--app-page-padding-x)]" aria-busy="true">
		<div class="mb-4 h-12 w-2/3 animate-pulse rounded bg-[color:var(--app-hover)]"></div>
		<div class="mb-2 h-4 w-full animate-pulse rounded bg-[color:var(--app-hover)]"></div>
		<div class="h-4 w-4/5 animate-pulse rounded bg-[color:var(--app-hover)]"></div>
	</div>
{/if}
