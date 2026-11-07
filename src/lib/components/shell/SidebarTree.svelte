<script lang="ts">
	import { caretRightIcon } from 'entasis/icons/caretRight';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { databaseIcon } from 'entasis/icons/database';
	import { plusIcon } from 'entasis/icons/plus';
	import type { PageEntity, WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import PresenceAvatars from './PresenceAvatars.svelte';

	let {
		store,
		ws,
		activeId,
		onCreate
	}: {
		store: WorkspaceStore;
		/** The workspace segment of the URL. */
		ws: string;
		activeId?: string;
		/** "+" on a row or a section: create a page there. */
		onCreate: (target: { parentId: string | null; teamspaceId?: string | null }) => void;
	} = $props();

	// Sections and teamspaces can fold; the default is open.
	let folded = $state<Record<string, boolean>>({});
	const open = (key: string) => !folded[key];
	const toggleSection = (key: string) => (folded[key] = !folded[key]);

	const teamspaces = $derived(store.teamspaces);
	const shared = $derived(store.sharedRoots());
	const mine = $derived(store.privateRoots());
	const STEP = 14;
	const pad = (depth: number) => `${6 + depth * STEP}px`;
</script>

{#snippet add(label: string, target: { parentId: string | null; teamspaceId?: string | null })}
	<button
		type="button"
		class="grid size-5 shrink-0 place-items-center rounded-[4px] text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-active)] hover:text-[color:var(--app-text)] disabled:cursor-not-allowed disabled:opacity-40"
		aria-label={label}
		title={store.canEdit ? label : 'Offline: pages can be added when you reconnect'}
		disabled={!store.canEdit}
		onclick={(e) => {
			e.preventDefault();
			e.stopPropagation();
			onCreate(target);
		}}
	>
		{@render plusIcon({ size: 14 })}
	</button>
{/snippet}

{#snippet pageIcon(page: PageEntity)}
	<span class="grid size-5 shrink-0 place-items-center text-[15px] leading-none text-[color:var(--app-text-tertiary)]">
		{#if page.icon}{page.icon}{:else if page.isDatabase}{@render databaseIcon({ size: 16 })}{:else}{@render fileTextIcon({ size: 16 })}{/if}
	</span>
{/snippet}

{#snippet node(page: PageEntity, depth: number)}
	{@const state = store.branchState(page.id)}
	{@const kids = store.children(page.id)}
	{@const active = page.id === activeId}
	<li role="none">
		<div
			class="group/row flex items-center gap-0.5 rounded-[var(--app-radius-control)] pr-1 text-[color:var(--app-text-sidebar)] hover:bg-[color:var(--app-hover)] {active
				? 'bg-[color:var(--app-active)] text-[color:var(--app-text)]'
				: ''}"
			style="height: var(--app-row-height); padding-left: {pad(depth)}"
			data-testid="tree-row"
			data-page-id={page.id}
		>
			{#if page.hasChildren}
				<button
					type="button"
					class="grid size-5 shrink-0 place-items-center rounded-[4px] text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-active)]"
					aria-label={state === 'collapsed' ? `Expand ${page.title || 'Untitled'}` : `Collapse ${page.title || 'Untitled'}`}
					aria-expanded={state !== 'collapsed'}
					onclick={() => store.toggle(page.id)}
				>
					<span class="transition-transform duration-100 {state !== 'collapsed' ? 'rotate-90' : ''}">
						{@render caretRightIcon({ size: 12 })}
					</span>
				</button>
			{:else}
				<span class="size-5 shrink-0" aria-hidden="true"></span>
			{/if}
			<a
				href={`/${ws}/${page.id}`}
				role="treeitem"
				aria-selected={active}
				aria-current={active ? 'page' : undefined}
				class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-sm no-underline"
				style="color: inherit"
			>
				{@render pageIcon(page)}
				<span class="truncate {page.title ? '' : 'text-[color:var(--app-text-tertiary)]'}">{page.title || 'Untitled'}</span>
			</a>
			<PresenceAvatars users={store.othersOn(page.id)} max={2} size={16} />
			<span class="hidden items-center group-hover/row:flex group-focus-within/row:flex">
				{@render add(`Add a page inside ${page.title || 'Untitled'}`, { parentId: page.id })}
			</span>
		</div>
		{#if state !== 'collapsed'}
			<ul role="group" class="m-0 list-none p-0">
				{#each kids as child (child.id)}
					{@render node(child, depth + 1)}
				{:else}
					<li
						class="flex items-center text-xs text-[color:var(--app-text-tertiary)]"
						style="height: var(--app-row-height); padding-left: {pad(depth + 1)}"
					>
						<span class="ml-6">{state === 'loading' ? 'Loading…' : 'No pages inside'}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</li>
{/snippet}

{#snippet header(key: string, label: string, onAdd?: () => void)}
	<div class="group/section flex items-center pr-1" style="height: var(--app-row-height); padding-left: 6px">
		<button
			type="button"
			class="flex h-full flex-1 items-center gap-1 rounded text-left text-xs font-medium text-[color:var(--app-text-tertiary)] hover:text-[color:var(--app-text-secondary)]"
			aria-expanded={open(key)}
			onclick={() => toggleSection(key)}
		>
			{label}
		</button>
		{#if onAdd}
			<span class="hidden group-hover/section:flex group-focus-within/section:flex">
				{@render add(`Add a page to ${label}`, { parentId: null })}
			</span>
		{/if}
	</div>
{/snippet}

<nav class="flex flex-col gap-3 px-2 pt-1 pb-4" aria-label="Pages" data-testid="sidebar-tree">
	{#if !store.ready}
		<div class="flex flex-col gap-1 px-1.5 pt-2" aria-busy="true" aria-label="Loading pages">
			{#each [60, 80, 50, 70, 40] as w, i (i)}
				<div class="h-5 animate-pulse rounded bg-[color:var(--app-hover)]" style="width: {w}%"></div>
			{/each}
		</div>
	{:else}
		{#if teamspaces.length}
			<section aria-label="Teamspaces">
				{@render header('teamspaces', 'Teamspaces')}
				{#if open('teamspaces')}
					<ul role="tree" class="m-0 list-none p-0">
						{#each teamspaces as ts (ts.id)}
							{@const roots = store.teamspaceRoots(ts.id)}
							<li role="none">
								<div
									class="group/ts flex items-center gap-0.5 rounded-[var(--app-radius-control)] pr-1 text-[color:var(--app-text-sidebar)] hover:bg-[color:var(--app-hover)]"
									style="height: var(--app-row-height); padding-left: 6px"
								>
									<button
										type="button"
										class="flex h-full min-w-0 flex-1 items-center gap-0.5 text-left text-sm"
										aria-expanded={open(`ts:${ts.id}`)}
										onclick={() => toggleSection(`ts:${ts.id}`)}
									>
										<span class="grid size-5 shrink-0 place-items-center text-[color:var(--app-text-tertiary)]">
											<span class="transition-transform duration-100 {open(`ts:${ts.id}`) ? 'rotate-90' : ''}">
												{@render caretRightIcon({ size: 12 })}
											</span>
										</span>
										<span class="grid size-5 shrink-0 place-items-center text-[15px] leading-none">{ts.icon ?? '👥'}</span>
										<span class="ml-1 truncate font-medium">{ts.name}</span>
									</button>
									<span class="hidden items-center group-hover/ts:flex group-focus-within/ts:flex">
										{@render add(`Add a page to ${ts.name}`, { parentId: null, teamspaceId: ts.id })}
									</span>
								</div>
								{#if open(`ts:${ts.id}`)}
									<ul role="group" class="m-0 list-none p-0">
										{#each roots as page (page.id)}
											{@render node(page, 1)}
										{:else}
											<li class="flex items-center text-xs text-[color:var(--app-text-tertiary)]" style="height: var(--app-row-height); padding-left: {pad(1)}">
												<span class="ml-6">No pages yet</span>
											</li>
										{/each}
									</ul>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		{#if shared.length}
			<section aria-label="Shared">
				{@render header('shared', 'Shared')}
				{#if open('shared')}
					<ul role="tree" class="m-0 list-none p-0">
						{#each shared as page (page.id)}
							{@render node(page, 0)}
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<section aria-label="Private">
			{@render header('private', 'Private', () => onCreate({ parentId: null, teamspaceId: null }))}
			{#if open('private')}
				<ul role="tree" class="m-0 list-none p-0">
					{#each mine as page (page.id)}
						{@render node(page, 0)}
					{:else}
						<li class="px-2 text-xs text-[color:var(--app-text-tertiary)]" style="line-height: var(--app-row-height)">
							Nothing here yet. Add a page with +.
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</nav>
