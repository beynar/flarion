<!--
	Dev only. The editor and the page header against a real room in `pnpm dev`, outside the app
	shell. The token comes from `POST /rooms/dev/token`, which answers 404 unless ENVIRONMENT is
	`development`. Query: `?ws=<workspace>&page=<page>&user=<id>&name=<name>&color=<css color>&access=<level>`.
-->
<script lang="ts">
	import { page as route } from '$app/state';
	import Editor from '#lib/components/editor/Editor.svelte';
	import PageHeader from '#lib/components/page-header/PageHeader.svelte';
	import type { PageHeaderAccess } from '#lib/components/page-header/types.ts';

	const q = $derived(route.url.searchParams);
	const workspaceId = $derived(q.get('ws') ?? 'dev');
	const pageId = $derived(q.get('page') ?? 'editor-test');
	const user = $derived({
		id: q.get('user') ?? 'ada',
		name: q.get('name') ?? q.get('user') ?? 'Ada',
		color: q.get('color') ?? undefined
	});
	const access = $derived((q.get('access') ?? 'write') as 'read' | 'comment' | 'write');

	/** Counts token requests, so a test can see the 4401 refresh happen. */
	let tokenRequests = $state(0);
	const getRoomToken = async () => {
		tokenRequests++;
		const ttl = q.get('ttl');
		const response = await fetch('/rooms/dev/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				workspaceId,
				pageId,
				userId: user.id,
				access,
				...(ttl ? { ttlSeconds: Number(ttl) } : {})
			})
		});
		if (!response.ok) throw new Error(`dev token refused: ${response.status}`);
		return (await response.json()) as { token: string; expiresAt: number; access: 'read' | 'comment' | 'write' };
	};

	// A stand-in for the workspace store: the header's fields and a few pages to link and mention.
	let header = $state({ title: 'Editor test page', icon: '📝' as string | null, cover: null as string | null, coverPosition: 50 });
	const known = $state([
		{ id: 'alpha', title: 'Alpha plan', icon: '🚀' },
		{ id: 'beta', title: 'Beta notes', icon: null as string | null },
		{ id: 'gamma', title: 'Gamma spec', icon: '📄' }
	]);
	const people = [
		{ id: 'ada', name: 'Ada Lovelace' },
		{ id: 'bob', name: 'Bob Martin' }
	];
	const titles: string[] = $state([]);

	// Tests drive the document directly (insert a whole rich page, read it back).
	let edytor = $state<import('edytor').EdytorInstance>();
	$effect(() => {
		(window as unknown as { __edytor?: unknown }).__edytor = edytor;
	});
</script>

<svelte:head><title>Editor test · Flarion</title></svelte:head>

<div data-testid="token-requests" hidden>{tokenRequests}</div>

<PageHeader
	page={{ id: pageId, ...header }}
	access={access === 'write' ? 'write' : access}
	backlinks={2}
	presence={[
		{ userId: 'ada', name: 'Ada Lovelace' },
		{ userId: 'bob', name: 'Bob Martin' }
	]}
	onTitle={(title) => {
		header.title = title;
		titles.push(title);
	}}
	onIcon={(icon) => (header.icon = icon)}
	onCover={(cover, position) => {
		header.cover = cover;
		if (position !== undefined) header.coverPosition = position;
	}}
/>
<div data-testid="title-writes" hidden>{JSON.stringify(titles)}</div>

<div class="mx-auto w-full px-[var(--app-page-padding-x-narrow)] pb-[30vh] md:px-[var(--app-page-padding-x)]" style="max-width: calc(var(--app-page-width) + 2 * var(--app-page-padding-x));">
	<Editor
		{workspaceId}
		{pageId}
		{getRoomToken}
		{user}
		bind:edytor
		resolvePage={(id) => known.find((entry) => entry.id === id)}
		searchPages={async (query) => known.filter((entry) => entry.title.toLowerCase().includes(query.toLowerCase()))}
		searchPeople={async (query) => people.filter((person) => person.name.toLowerCase().includes(query.toLowerCase()))}
		onSubpage={async ({ title }) => {
			const id = `sub${Math.random().toString(36).slice(2, 8)}`;
			known.push({ id, title: title ?? 'Untitled', icon: null });
			return { id };
		}}
		onNavigate={(id) => console.info('navigate', id)}
	/>
</div>
