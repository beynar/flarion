<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { toast } from 'entasis/toast';
	import { caretRightIcon } from 'entasis/icons/caretRight';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { databaseIcon } from 'entasis/icons/database';
	import { plusIcon } from 'entasis/icons/plus';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { starIcon, starIconFill } from 'entasis/icons/star';
	import { linkIcon } from 'entasis/icons/link';
	import { copyIcon } from 'entasis/icons/copy';
	import { pencilSimpleIcon } from 'entasis/icons/pencilSimple';
	import { arrowBendUpRightIcon } from 'entasis/icons/arrowBendUpRight';
	import { arrowSquareOutIcon } from 'entasis/icons/arrowSquareOut';
	import { trashIcon } from 'entasis/icons/trash';
	import { gearIcon } from 'entasis/icons/gear';
	import { signOutIcon } from 'entasis/icons/signOut';
	import { usersThreeIcon } from 'entasis/icons/usersThree';
	import type { PageEntity, WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import CreateTeamspaceDialog from '#lib/components/teamspaces/CreateTeamspaceDialog.svelte';
	import TeamspaceSettingsDialog from '#lib/components/teamspaces/TeamspaceSettingsDialog.svelte';
	import { trashWithUndo } from '#lib/components/trash/trash-actions.ts';
	import MovePageDialog from './MovePageDialog.svelte';
	import PresenceAvatars from './PresenceAvatars.svelte';
	import {
		pageRow,
		scrollParent,
		sectionHeader,
		watchTreeDrags,
		type DropTargetData,
		type DropZone,
		type SectionRef
	} from './tree-dnd.ts';

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

	// ───────────── folding (sections and teamspaces), remembered per browser ─────────────
	const FOLD_KEY = 'flarion.sidebar.folded';
	let folded = $state<Record<string, boolean>>({});
	const open = (key: string) => !folded[key];
	function toggleSection(key: string) {
		folded[key] = !folded[key];
		try {
			localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
		} catch {
			// private mode: the fold state just does not persist
		}
	}

	const teamspaces = $derived(store.myTeamspaces);
	const shared = $derived(store.sharedRoots());
	const mine = $derived(store.privateRoots());
	const STEP = 14;
	const pad = (depth: number) => `${6 + depth * STEP}px`;
	const padPx = (depth: number) => 6 + depth * STEP;

	// ───────────── drag and drop ─────────────
	let nav = $state<HTMLElement>();
	let dragId = $state<string | null>(null);
	type Drop = { id: string; zone: DropZone; ok: boolean; firstChild: boolean };
	let drop = $state<Drop | null>(null);
	let sectionDrop = $state<{ key: string; ok: boolean } | null>(null);
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;
	let hoverId: string | null = null;

	const sectionKey = (s: SectionRef) => (s.kind === 'teamspace' ? `ts:${s.id}` : s.kind);
	const sectionTarget = (s: SectionRef) => ({ parentId: null, teamspaceId: s.kind === 'teamspace' ? s.id : null, shared: s.kind === 'shared' });

	/** Where a drop on `zone` of row `id` would put the dragged page. */
	function destFor(id: string, zone: DropZone) {
		const p = store.page(id);
		if (!p) return null;
		const root = p.parentId === null;
		const where = { parentId: p.parentId, teamspaceId: root ? (p.teamspaceId ?? null) : undefined, shared: root && store.sectionOf(p).kind === 'shared' };
		if (zone === 'into') return { dest: { parentId: p.id }, firstChild: false };
		if (zone === 'before') return { dest: { ...where, beforeId: p.id }, firstChild: false };
		// Below an open branch the page becomes its first child, as the indicator shows.
		if (store.isExpanded(p.id) && store.children(p.id).length) return { dest: { parentId: p.id, index: 0 }, firstChild: true };
		return { dest: { ...where, afterId: p.id }, firstChild: false };
	}

	function clearHover() {
		if (hoverTimer) clearTimeout(hoverTimer);
		hoverTimer = null;
		hoverId = null;
	}

	/** Opens a collapsed branch after the pointer rests on it for a moment. */
	function autoExpand(id: string) {
		if (hoverId === id) return;
		clearHover();
		const p = store.page(id);
		if (!p?.hasChildren || store.isExpanded(id)) return;
		hoverId = id;
		hoverTimer = setTimeout(() => {
			store.expand(id);
			clearHover();
		}, 550);
	}

	function onTarget(sourceId: string, target: DropTargetData | null) {
		drop = null;
		sectionDrop = null;
		if (!target) return clearHover();
		if (target.kind === 'section') {
			clearHover();
			sectionDrop = { key: sectionKey(target.section), ok: store.canMove(sourceId, sectionTarget(target.section)).ok };
			return;
		}
		if (target.id === sourceId) return clearHover();
		const resolved = destFor(target.id, target.zone);
		if (!resolved) return clearHover();
		const ok = store.canMove(sourceId, resolved.dest).ok;
		drop = { id: target.id, zone: target.zone, ok, firstChild: resolved.firstChild };
		if (target.zone === 'into' && ok) autoExpand(target.id);
		else clearHover();
	}

	function onDrop(sourceId: string, target: DropTargetData | null) {
		clearHover();
		if (!target) return;
		if (target.kind === 'section') {
			void store.movePage(sourceId, sectionTarget(target.section));
			return;
		}
		if (target.id === sourceId) return;
		const resolved = destFor(target.id, target.zone);
		if (resolved) void store.movePage(sourceId, resolved.dest);
	}

	onMount(() => {
		let folds: Record<string, boolean> = {};
		try {
			folds = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
		} catch {
			// ignore a corrupt value
		}
		folded = folds;
		const stop = watchTreeDrags(scrollParent(nav ?? null), {
			onTarget,
			onDrop,
			onEnd() {
				dragId = null;
				drop = null;
				sectionDrop = null;
				clearHover();
			}
		});
		return () => {
			stop();
			clearHover();
		};
	});

	// ───────────── rename ─────────────
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	function startRename(id: string) {
		renameValue = store.page(id)?.title ?? '';
		renamingId = id;
	}
	function commitRename() {
		const id = renamingId;
		renamingId = null;
		if (id && renameValue !== (store.page(id)?.title ?? '')) store.setTitle(id, renameValue.trim());
	}
	const focusSelect = (node: HTMLInputElement) => {
		node.focus();
		node.select();
	};

	// ───────────── menus ─────────────
	type MenuTarget = { kind: 'page'; id: string } | { kind: 'teamspace'; id: string } | { kind: 'teamspaces' };
	let menuOpen = $state(false);
	let menuTarget = $state<MenuTarget | null>(null);
	let menuRef = $state<HTMLElement | { getBoundingClientRect: () => DOMRect } | null>(null);

	function openMenu(target: MenuTarget, anchor: HTMLElement | { getBoundingClientRect: () => DOMRect }) {
		menuTarget = target;
		menuRef = anchor;
		menuOpen = true;
	}
	function contextMenu(event: MouseEvent, target: MenuTarget) {
		event.preventDefault();
		openMenu(target, { getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0) });
	}
	function menuButton(event: Event, target: MenuTarget) {
		event.preventDefault();
		event.stopPropagation();
		openMenu(target, event.currentTarget as HTMLElement);
	}

	let moveId = $state<string | null>(null);
	let moveOpen = $state(false);
	let createTsOpen = $state(false);
	let tsSettingsId = $state<string | null>(null);
	let tsSettingsOpen = $state(false);

	const pageUrl = (id: string) => `${location.origin}/${ws}/${id}`;

	async function copyLink(id: string) {
		try {
			await navigator.clipboard.writeText(pageUrl(id));
			toast.success({ title: 'Link copied' });
		} catch {
			toast.danger({ title: 'Could not copy the link', description: pageUrl(id) });
		}
	}

	async function duplicate(id: string) {
		const copy = await store.duplicatePage(id);
		if (copy) await goto(`/${ws}/${copy}`);
	}

	async function trash(id: string) {
		const inside = !!activeId && store.isInside(activeId, id);
		await trashWithUndo(store, id, { onTrashed: () => (inside ? goto(`/${ws}`) : undefined) });
	}

	async function leave(teamspaceId: string) {
		try {
			await store.removeTeamspaceMember(teamspaceId, store.user.id);
		} catch {
			// the store has raised the toast (a teamspace needs an owner)
		}
	}

	const menuItems = $derived.by((): MenuItem[] => {
		const t = menuTarget;
		if (!t) return [];
		if (t.kind === 'teamspaces') {
			return [
				{ type: 'option', title: 'New teamspace', prefix: plusIcon, onclick: () => (createTsOpen = true) },
				{ type: 'option', title: 'Browse teamspaces', prefix: usersThreeIcon, href: `/${ws}/settings/teamspaces` }
			];
		}
		if (t.kind === 'teamspace') {
			const ts = store.teamspaces.find((x) => x.id === t.id);
			return [
				{ type: 'option', title: 'Teamspace settings', prefix: gearIcon, onclick: () => ((tsSettingsId = t.id), (tsSettingsOpen = true)) },
				{ type: 'option', title: 'Add a page', prefix: plusIcon, disabled: !store.canEdit, onclick: () => onCreate({ parentId: null, teamspaceId: t.id }) },
				{ type: 'separator' },
				{ type: 'option', title: 'Leave teamspace', prefix: signOutIcon, color: 'danger', disabled: !ts?.myRole || !store.canEdit, onclick: () => void leave(t.id) }
			];
		}
		const p = store.page(t.id);
		if (!p) return [];
		const online = store.canEdit;
		const canEdit = online && (p.access === 'update' || p.access === 'full');
		const canFull = online && p.access === 'full';
		const fav = store.isFavorite(p.id);
		return [
			{ type: 'option', title: fav ? 'Remove from favorites' : 'Add to favorites', prefix: fav ? starIconFill : starIcon, onclick: () => store.toggleFavorite(p.id) },
			{ type: 'option', title: 'Copy link', prefix: linkIcon, onclick: () => void copyLink(p.id) },
			{ type: 'option', title: 'Duplicate', prefix: copyIcon, disabled: !canEdit, onclick: () => void duplicate(p.id) },
			{ type: 'option', title: 'Rename', prefix: pencilSimpleIcon, disabled: !canEdit, onclick: () => startRename(p.id) },
			{ type: 'option', title: 'Move to…', prefix: arrowBendUpRightIcon, disabled: !canFull, onclick: () => ((moveId = p.id), (moveOpen = true)) },
			{ type: 'option', title: 'Open in new tab', prefix: arrowSquareOutIcon, href: `/${ws}/${p.id}`, target: '_blank' },
			{ type: 'separator' },
			{ type: 'option', title: 'Delete', prefix: trashIcon, color: 'danger', disabled: !canFull, onclick: () => void trash(p.id) }
		];
	});

	// ───────────── keyboard ─────────────
	/** Alt+Up and Alt+Down move the focused page among its siblings: the keyboard way to reorder. */
	async function nudge(id: string, delta: -1 | 1) {
		const p = store.page(id);
		if (!p) return;
		const sibs = store.siblingsOf(id);
		const at = sibs.findIndex((s) => s.id === id);
		const to = at + delta;
		if (at === -1 || to < 0 || to >= sibs.length) return;
		const root = p.parentId === null;
		await store.movePage(id, {
			parentId: p.parentId,
			teamspaceId: root ? (p.teamspaceId ?? null) : undefined,
			shared: root && store.sectionOf(p).kind === 'shared',
			index: to
		});
		await Promise.resolve();
		nav?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"] [role="treeitem"]`)?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		const el = event.target as HTMLElement;
		if (el.tagName === 'INPUT' || el.getAttribute('role') !== 'treeitem') return;
		const row = el.closest<HTMLElement>('[data-page-id]');
		const id = row?.dataset.pageId;
		if (!id || !row) return;
		if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
			event.preventDefault();
			openMenu({ kind: 'page', id }, row);
		} else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault();
			void nudge(id, event.key === 'ArrowUp' ? -1 : 1);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const items = [...(nav?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
			items[items.indexOf(el) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
		} else if (event.key === 'ArrowRight' && store.page(id)?.hasChildren) {
			event.preventDefault();
			store.expand(id);
		} else if (event.key === 'ArrowLeft' && store.isExpanded(id)) {
			event.preventDefault();
			store.collapse(id);
		} else if (event.key === 'F2') {
			event.preventDefault();
			startRename(id);
		}
	}
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

{#snippet more(label: string, target: MenuTarget)}
	<button
		type="button"
		class="grid size-5 shrink-0 place-items-center rounded-[4px] text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-active)] hover:text-[color:var(--app-text)]"
		aria-label={label}
		aria-haspopup="menu"
		data-testid="row-menu"
		onclick={(e) => menuButton(e, target)}
	>
		{@render dotsThreeIcon({ size: 14 })}
	</button>
{/snippet}

{#snippet pageIcon(page: PageEntity)}
	<span class="grid size-5 shrink-0 place-items-center text-[15px] leading-none text-[color:var(--app-text-tertiary)]">
		{#if page.icon}{page.icon}{:else if page.isDatabase}{@render databaseIcon({ size: 16 })}{:else}{@render fileTextIcon({ size: 16 })}{/if}
	</span>
{/snippet}

{#snippet indicator(d: Drop, depth: number)}
	{#if d.zone === 'into'}
		<span
			class="pointer-events-none absolute inset-0 rounded-[var(--app-radius-control)]"
			style="box-shadow: inset 0 0 0 2px var(--app-accent); background: color-mix(in srgb, var(--app-accent) 12%, transparent)"
			data-testid="drop-into"
		></span>
	{:else}
		<span
			class="pointer-events-none absolute right-1 h-0.5 rounded-full {d.zone === 'before' ? '-top-px' : '-bottom-px'}"
			style="left: {padPx(depth + (d.firstChild ? 1 : 0)) + 22}px; background: var(--app-accent)"
			data-testid="drop-{d.zone}"
		></span>
	{/if}
{/snippet}

{#snippet node(page: PageEntity, depth: number)}
	{@const state = store.branchState(page.id)}
	{@const kids = store.children(page.id)}
	{@const active = page.id === activeId}
	{@const mark = drop?.id === page.id && drop.ok ? drop : null}
	<li role="none">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="group/row relative flex items-center gap-0.5 rounded-[var(--app-radius-control)] pr-1 text-[color:var(--app-text-sidebar)] hover:bg-[color:var(--app-hover)] {active
				? 'bg-[color:var(--app-active)] text-[color:var(--app-text)]'
				: ''} {dragId === page.id ? 'opacity-40' : ''}"
			style="height: var(--app-row-height); padding-left: {pad(depth)}"
			data-testid="tree-row"
			data-page-id={page.id}
			use:pageRow={{ id: page.id, onDragStart: () => (dragId = page.id), onDragEnd: () => (dragId = null) }}
			oncontextmenu={(e) => contextMenu(e, { kind: 'page', id: page.id })}
		>
			{#if mark}{@render indicator(mark, depth)}{/if}
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
			{#if renamingId === page.id}
				<span class="flex h-full min-w-0 flex-1 items-center gap-1.5">
					{@render pageIcon(page)}
					<input
						class="h-5 min-w-0 flex-1 rounded-[3px] border border-[color:var(--app-accent)] bg-[color:var(--app-page)] px-1 text-sm text-[color:var(--app-text)] outline-none"
						aria-label="Page name"
						data-testid="tree-rename"
						bind:value={renameValue}
						use:focusSelect
						onblur={commitRename}
						onkeydown={(e) => {
							if (e.key === 'Enter') commitRename();
							else if (e.key === 'Escape') renamingId = null;
						}}
					/>
				</span>
			{:else}
				<a
					href={`/${ws}/${page.id}`}
					role="treeitem"
					aria-selected={active}
					aria-current={active ? 'page' : undefined}
					draggable="false"
					class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-sm no-underline"
					style="color: inherit"
				>
					{@render pageIcon(page)}
					<span class="truncate {page.title ? '' : 'text-[color:var(--app-text-tertiary)]'}" data-testid="tree-title">{page.title || 'Untitled'}</span>
				</a>
			{/if}
			<PresenceAvatars users={store.othersOn(page.id)} max={2} size={16} />
			<span class="hidden items-center group-hover/row:flex group-focus-within/row:flex">
				{@render more(`More actions for ${page.title || 'Untitled'}`, { kind: 'page', id: page.id })}
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

{#snippet header(key: string, label: string, section: SectionRef | null, actions?: import('svelte').Snippet)}
	<div
		class="group/section relative flex items-center rounded-[var(--app-radius-control)] pr-1 {sectionDrop?.key === key && sectionDrop.ok ? 'bg-[color:var(--app-active)]' : ''}"
		style="height: var(--app-row-height); padding-left: 6px; {sectionDrop?.key === key && sectionDrop.ok ? 'box-shadow: inset 0 0 0 2px var(--app-accent)' : ''}"
		data-testid="section-header"
		data-section={key}
		use:sectionHeader={section ?? { kind: 'private' }}
	>
		<button
			type="button"
			class="flex h-full flex-1 items-center gap-1 rounded text-left text-xs font-medium text-[color:var(--app-text-tertiary)] hover:text-[color:var(--app-text-secondary)]"
			aria-expanded={open(key)}
			onclick={() => toggleSection(key)}
		>
			{label}
		</button>
		{#if actions}
			<span class="hidden group-hover/section:flex group-focus-within/section:flex">{@render actions()}</span>
		{/if}
	</div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<nav bind:this={nav} class="flex flex-col gap-3 px-2 pt-1 pb-4" aria-label="Pages" data-testid="sidebar-tree" onkeydown={onKeydown}>
	{#if !store.ready}
		<div class="flex flex-col gap-1 px-1.5 pt-2" aria-busy="true" aria-label="Loading pages">
			{#each [60, 80, 50, 70, 40] as w, i (i)}
				<div class="h-5 animate-pulse rounded bg-[color:var(--app-hover)]" style="width: {w}%"></div>
			{/each}
		</div>
	{:else}
		<section aria-label="Teamspaces" data-testid="section-teamspaces">
			{#snippet teamspacesActions()}
				{@render more('Teamspace options', { kind: 'teamspaces' })}
				<button
					type="button"
					class="grid size-5 shrink-0 place-items-center rounded-[4px] text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-active)] hover:text-[color:var(--app-text)]"
					aria-label="New teamspace"
					onclick={() => (createTsOpen = true)}
				>
					{@render plusIcon({ size: 14 })}
				</button>
			{/snippet}
			{@render header('teamspaces', 'Teamspaces', null, teamspacesActions)}
			{#if open('teamspaces')}
				<ul role="tree" class="m-0 list-none p-0">
					{#each teamspaces as ts (ts.id)}
						{@const roots = store.teamspaceRoots(ts.id)}
						{@const key = `ts:${ts.id}`}
						<li role="none" data-testid="teamspace" data-teamspace-id={ts.id}>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="group/ts relative flex items-center gap-0.5 rounded-[var(--app-radius-control)] pr-1 text-[color:var(--app-text-sidebar)] hover:bg-[color:var(--app-hover)] {sectionDrop?.key === key && sectionDrop.ok ? 'bg-[color:var(--app-active)]' : ''}"
								style="height: var(--app-row-height); padding-left: 6px; {sectionDrop?.key === key && sectionDrop.ok ? 'box-shadow: inset 0 0 0 2px var(--app-accent)' : ''}"
								data-testid="section-header"
								data-section={key}
								use:sectionHeader={{ kind: 'teamspace', id: ts.id }}
								oncontextmenu={(e) => contextMenu(e, { kind: 'teamspace', id: ts.id })}
							>
								<button
									type="button"
									class="flex h-full min-w-0 flex-1 items-center gap-0.5 text-left text-sm"
									aria-expanded={open(key)}
									onclick={() => toggleSection(key)}
								>
									<span class="grid size-5 shrink-0 place-items-center text-[color:var(--app-text-tertiary)]">
										<span class="transition-transform duration-100 {open(key) ? 'rotate-90' : ''}">
											{@render caretRightIcon({ size: 12 })}
										</span>
									</span>
									<span class="grid size-5 shrink-0 place-items-center text-[15px] leading-none">{ts.icon ?? '👥'}</span>
									<span class="ml-1 truncate font-medium">{ts.name}</span>
								</button>
								<span class="hidden items-center group-hover/ts:flex group-focus-within/ts:flex">
									{@render more(`More actions for ${ts.name}`, { kind: 'teamspace', id: ts.id })}
									{@render add(`Add a page to ${ts.name}`, { parentId: null, teamspaceId: ts.id })}
								</span>
							</div>
							{#if open(key)}
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
					{:else}
						<li class="px-2 text-xs text-[color:var(--app-text-tertiary)]" style="line-height: var(--app-row-height)">
							<a href={`/${ws}/settings/teamspaces`} class="no-underline hover:text-[color:var(--app-text-secondary)]" style="color: inherit">Join or create a teamspace</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if shared.length}
			<section aria-label="Shared" data-testid="section-shared">
				{@render header('shared', 'Shared', { kind: 'shared' })}
				{#if open('shared')}
					<ul role="tree" class="m-0 list-none p-0">
						{#each shared as page (page.id)}
							{@render node(page, 0)}
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<section aria-label="Private" data-testid="section-private">
			{#snippet privateActions()}
				{@render add('Add a page to Private', { parentId: null, teamspaceId: null })}
			{/snippet}
			{@render header('private', 'Private', { kind: 'private' }, privateActions)}
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

<PopupMenu
	trigger={false}
	bind:open={menuOpen}
	ref={menuRef}
	position="bottom-start"
	menu={{ items: menuItems }}
	onAfterClose={() => (menuTarget = null)}
/>

<MovePageDialog {store} pageId={moveId} bind:open={moveOpen} />
<CreateTeamspaceDialog {store} bind:open={createTsOpen} />
<TeamspaceSettingsDialog {store} teamspaceId={tsSettingsId} bind:open={tsSettingsOpen} />
