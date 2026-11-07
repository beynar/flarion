<script lang="ts">
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { toast } from 'entasis/toast';
	import { buildingsIcon } from 'entasis/icons/buildings';
	import { copyIcon } from 'entasis/icons/copy';
	import { globeIcon } from 'entasis/icons/globe';
	import { usersThreeIcon } from 'entasis/icons/usersThree';
	import { xIcon } from 'entasis/icons/x';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { inviteGuestToPage, listGrants, publishPage, revokeGrant, setGrant } from '#lib/client/share.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Grant } from '#lib/shared/schemas.ts';
	import { LEVELS, levelLabel } from '#lib/components/teamspaces/levels.ts';
	import LevelSelect from './LevelSelect.svelte';
	import {
		grantRows,
		inviteSuggestions,
		publicGrant,
		publicLink,
		shareErrorMessage,
		teamspaceAccess,
		workspaceGrant,
		type Suggestion
	} from './grants.ts';

	let {
		store,
		pageId,
		open = $bindable(false)
	}: {
		store: WorkspaceStore;
		pageId: string;
		open: boolean;
	} = $props();

	const page = $derived(store.page(pageId));
	const canShare = $derived(page?.access === 'full' && store.canEdit);

	let tab = $state<'share' | 'publish'>('share');
	let grants = $state.raw<Grant[]>([]);
	let loadState = $state<'loading' | 'ready' | 'error'>('loading');
	let error = $state('');
	let busy = $state(false);

	// invite box
	let query = $state('');
	let target = $state<Suggestion | null>(null);
	let inviteLevel = $state<AccessLevel>('update');
	let suggestOpen = $state(false);

	const ctx = $derived({ pageId, members: store.members, teamspaces: store.teamspaces });
	const rows = $derived(grantRows(grants, ctx));
	const general = $derived(workspaceGrant(grants, pageId));
	const published = $derived(publicGrant(grants, pageId));
	const tsAccess = $derived(page ? teamspaceAccess(page, store.teamspaces) : null);
	const creator = $derived(page?.createdBy ? store.members.find((m) => m.userId === page.createdBy) : undefined);
	const suggestions = $derived(inviteSuggestions(query, { ...ctx, grants, selfId: store.user.id, excludeIds: page?.createdBy ? [page.createdBy] : [] }));
	const link = $derived(published?.token ? publicLink(typeof location === 'undefined' ? '' : location.origin, published.token) : '');
	const pageTitle = (id: string) => store.page(id)?.title || 'Untitled';

	// Load the grants each time the dialog opens (or moves to another page).
	$effect(() => {
		const id = pageId;
		if (!open || !id) return;
		tab = 'share';
		query = '';
		target = null;
		error = '';
		void refresh(id, true);
	});

	async function refresh(id = pageId, first = false) {
		if (first) loadState = 'loading';
		try {
			grants = await listGrants(id);
			loadState = 'ready';
		} catch (e) {
			if (first) loadState = 'error';
			error = shareErrorMessage(e);
		}
	}

	async function act(work: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await work();
			await refresh();
		} catch (e) {
			error = shareErrorMessage(e);
		} finally {
			busy = false;
		}
	}

	function pick(s: Suggestion) {
		target = s;
		query = s.kind === 'email' ? s.email : s.name;
		suggestOpen = false;
	}

	async function invite() {
		const chosen = target ?? suggestions[0];
		if (!chosen || !canShare) return;
		await act(async () => {
			if (chosen.kind === 'email') await inviteGuestToPage({ pageId, email: chosen.email, level: inviteLevel });
			else await setGrant({ pageId, subjectKind: chosen.kind, subjectId: chosen.id, level: inviteLevel });
			if (chosen.kind === 'email') toast.success({ title: 'Invitation sent', description: chosen.email });
		});
		if (!error) {
			query = '';
			target = null;
		}
	}

	const changeLevel = (g: Grant, level: AccessLevel) =>
		act(() => setGrant({ pageId, subjectKind: g.subjectKind, subjectId: g.subjectId, level, ...(g.pending && g.email ? { email: g.email } : {}) }));
	const remove = (g: Grant) => act(() => revokeGrant(g.id));

	function setGeneral(value: string) {
		if (!value) {
			if (general && general.pageId === pageId) void act(() => revokeGrant(general.id));
			return;
		}
		void act(() => setGrant({ pageId, subjectKind: 'workspace', subjectId: null, level: value as AccessLevel }));
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(link);
			toast.success({ title: 'Link copied' });
		} catch {
			toast.info({ title: 'Copy the link', description: link });
		}
	}

	const togglePublish = () => {
		if (published && published.pageId === pageId) void act(() => revokeGrant(published.id));
		else void act(() => publishPage(pageId));
	};
</script>

{#snippet avatarFor(kind: 'user' | 'pending' | 'teamspace', name: string, icon?: string | null)}
	{#if kind === 'teamspace'}
		<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{icon ?? '👥'}</span>
	{:else}
		<Avatar size="small" {name} />
	{/if}
{/snippet}

<Dialog bind:open size="small" closable>
	{#snippet title()}Share{#if page}<span class="ml-2 font-normal text-[color:var(--app-text-secondary)]">{page.title || 'Untitled'}</span>{/if}{/snippet}
	{#snippet children()}
		<div class="flex flex-col gap-3 pb-2" data-testid="share-dialog" data-page-id={pageId}>
			<div class="flex gap-1 border-b border-[color:var(--app-hairline)]" role="tablist" aria-label="Share options">
				{#each [{ id: 'share', label: 'Share' }, { id: 'publish', label: 'Publish' }] as t (t.id)}
					<button
						type="button"
						role="tab"
						aria-selected={tab === t.id}
						data-testid={t.id === 'publish' ? 'publish-tab' : 'share-tab'}
						class="-mb-px h-8 border-b-2 px-2 text-sm {tab === t.id
							? 'border-[color:var(--app-text)] text-[color:var(--app-text)]'
							: 'border-transparent text-[color:var(--app-text-secondary)] hover:text-[color:var(--app-text)]'}"
						onclick={() => (tab = t.id as 'share' | 'publish')}
					>
						{t.label}
					</button>
				{/each}
			</div>

			{#if error}
				<p class="m-0 rounded-[var(--app-radius-control)] bg-[color:var(--app-block-red-bg)] px-2.5 py-1.5 text-sm text-[color:var(--app-block-red)]" role="alert" data-testid="share-error">{error}</p>
			{/if}

			{#if tab === 'share'}
				{#if canShare}
					<div class="relative flex items-center gap-1.5">
						<input
							class="h-[var(--app-input-height)] min-w-0 flex-1 rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] px-2.5 text-sm outline-none focus:border-[color:var(--app-accent)]"
							placeholder="Add people, groups or emails"
							aria-label="Invite people"
							role="combobox"
							aria-expanded={suggestOpen && suggestions.length > 0}
							aria-controls="share-suggestions"
							autocomplete="off"
							data-testid="share-invite-input"
							bind:value={query}
							oninput={() => {
								target = null;
								suggestOpen = true;
							}}
							onfocus={() => (suggestOpen = true)}
							onblur={() => setTimeout(() => (suggestOpen = false), 120)}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void invite();
								} else if (e.key === 'Escape' && suggestOpen) {
									e.stopPropagation();
									suggestOpen = false;
								}
							}}
						/>
						<LevelSelect value={inviteLevel} label="Access level of the invitation" onchange={(l) => (inviteLevel = l)} testid="share-invite-level" />
						<Button size="small" disabled={busy || !(target ?? suggestions[0])} onclick={invite} data-testid="share-invite-submit">Invite</Button>
						{#if suggestOpen && suggestions.length}
							<ul
								id="share-suggestions"
								role="listbox"
								class="absolute top-full right-0 left-0 z-20 m-0 mt-1 max-h-56 list-none overflow-y-auto rounded-[var(--app-radius-panel)] bg-[color:var(--surface-floating,var(--app-page))] p-1"
								style="box-shadow: var(--app-shadow-menu)"
							>
								{#each suggestions as s, i (i)}
									<li role="option" aria-selected={i === 0}>
										<button
											type="button"
											class="flex h-[var(--app-row-height)] w-full items-center gap-2 rounded px-1.5 text-left text-sm hover:bg-[color:var(--app-hover)]"
											data-testid="share-suggestion"
											onmousedown={(e) => e.preventDefault()}
											onclick={() => pick(s)}
										>
											{#if s.kind === 'user'}
												<Avatar size="small" name={s.name} />
												<span class="truncate">{s.name}</span>
												<span class="ml-auto truncate text-xs text-[color:var(--app-text-tertiary)]">{s.email}</span>
											{:else if s.kind === 'teamspace'}
												<span class="grid size-6 place-items-center text-lg leading-none">{s.icon ?? '👥'}</span>
												<span class="truncate">{s.name}</span>
												<span class="ml-auto text-xs text-[color:var(--app-text-tertiary)]">Teamspace</span>
											{:else}
												<Avatar size="small" name={s.email} />
												<span class="truncate">Invite {s.email}</span>
												<span class="ml-auto text-xs text-[color:var(--app-text-tertiary)]">Guest</span>
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{:else if page}
					<p class="m-0 text-xs text-[color:var(--app-text-tertiary)]" data-testid="share-readonly">
						{store.canEdit ? 'You need full access to share this page.' : 'Sharing needs a connection.'}
					</p>
				{/if}

				{#if loadState === 'loading'}
					<div class="flex flex-col gap-1" aria-busy="true" aria-label="Loading access">
						{#each [1, 2] as i (i)}<div class="h-9 animate-pulse rounded bg-[color:var(--app-hover)]"></div>{/each}
					</div>
				{:else if loadState === 'error' && !grants.length}
					<div class="flex items-center gap-2 text-sm text-[color:var(--app-text-secondary)]">
						<span>Could not load who has access.</span>
						<Button variant="ghost" size="small" onclick={() => refresh(pageId, true)}>Retry</Button>
					</div>
				{:else}
					<ul class="m-0 flex list-none flex-col p-0" aria-label="People with access">
						{#if creator}
							<li class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="share-grant-row" data-subject={`owner:${creator.userId}`}>
								<Avatar size="small" name={creator.name} />
								<span class="flex min-w-0 flex-1 flex-col leading-tight">
									<span class="truncate">{creator.name}{creator.userId === store.user.id ? ' (you)' : ''}</span>
									<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{creator.email}</span>
								</span>
								<span class="px-1.5 text-xs text-[color:var(--app-text-secondary)]">Owner</span>
							</li>
						{/if}
						{#if tsAccess}
							<li class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="share-grant-row" data-subject={`teamspace-default:${tsAccess.teamspace.id}`}>
								<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{tsAccess.teamspace.icon ?? '👥'}</span>
								<span class="flex min-w-0 flex-1 flex-col leading-tight">
									<span class="truncate">Everyone in {tsAccess.teamspace.name}</span>
									<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">Teamspace access</span>
								</span>
								<span class="px-1.5 text-xs text-[color:var(--app-text-secondary)]">{levelLabel(tsAccess.level)}</span>
							</li>
						{/if}
						{#each rows as r (r.key)}
							{@const subject = r.kind === 'pending' ? `email:${r.email}` : `${r.kind}:${r.grant.subjectId}`}
							<li class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="share-grant-row" data-subject={subject} data-inherited={r.inherited}>
								{@render avatarFor(r.kind, r.name, r.kind === 'teamspace' ? store.teamspaces.find((t) => t.id === r.grant.subjectId)?.icon : null)}
								<span class="flex min-w-0 flex-1 flex-col leading-tight">
									<span class="truncate">{r.name}{r.grant.subjectId === store.user.id ? ' (you)' : ''}</span>
									<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">
										{#if r.inherited}
											{r.fromPageId && store.page(r.fromPageId) ? `from ${pageTitle(r.fromPageId)}` : 'from parent page'}
										{:else if r.kind === 'pending'}
											Guest invitation sent
										{:else if r.kind === 'teamspace'}
											Teamspace
										{:else}
											{r.email ?? ''}
										{/if}
									</span>
								</span>
								<LevelSelect
									value={r.level}
									label={`Access level of ${r.name}`}
									disabled={!canShare || r.inherited || busy}
									onchange={(l) => changeLevel(r.grant, l)}
								/>
								{#if canShare && !r.inherited}
									<button
										type="button"
										class="grid size-6 shrink-0 place-items-center rounded text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-hover)] hover:text-[color:var(--app-text)]"
										aria-label={`Remove ${r.name}`}
										data-testid="share-remove"
										disabled={busy}
										onclick={() => remove(r.grant)}
									>
										{@render xIcon({ size: 14 })}
									</button>
								{:else}
									<span class="size-6 shrink-0" aria-hidden="true"></span>
								{/if}
							</li>
						{/each}
					</ul>

					<div class="border-t border-[color:var(--app-hairline)] pt-2">
						<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">General access</h3>
						<div class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="share-general-row">
							<span class="grid size-6 shrink-0 place-items-center rounded bg-[color:var(--app-hover)] text-[color:var(--app-text-secondary)]">
								{@render buildingsIcon({ size: 16 })}
							</span>
							<span class="flex min-w-0 flex-1 flex-col leading-tight">
								<span class="truncate">Everyone at {store.workspace.name}</span>
								<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">
									{general
										? general.pageId === pageId
											? 'Any workspace member can open it'
											: 'from parent page'
										: 'Only people invited can open it'}
								</span>
							</span>
							<select
								class="h-[var(--app-button-height-small)] rounded-[var(--app-radius-control)] border border-transparent bg-transparent px-1.5 text-xs text-[color:var(--app-text-secondary)] hover:bg-[color:var(--app-hover)] disabled:appearance-none"
								aria-label="General access"
								data-testid="share-general"
								disabled={!canShare || busy || (!!general && general.pageId !== pageId)}
								value={general?.level ?? ''}
								onchange={(e) => setGeneral(e.currentTarget.value)}
							>
								<option value="">Only people invited</option>
								{#each LEVELS as l (l.value)}<option value={l.value}>{l.label}</option>{/each}
							</select>
						</div>
					</div>
				{/if}
			{:else}
				<div class="flex flex-col gap-3 py-1" data-testid="publish-panel">
					<div class="flex items-start gap-3">
						<span class="grid size-8 shrink-0 place-items-center rounded-[var(--app-radius-control)] bg-[color:var(--app-hover)] text-[color:var(--app-text-secondary)]">
							{@render globeIcon({ size: 18 })}
						</span>
						<div class="flex min-w-0 flex-1 flex-col text-sm">
							<span class="font-medium">{published ? 'This page is published' : 'Publish to the web'}</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">
								{published ? 'Anyone with the link can view it, without signing in.' : 'Anyone with the link will be able to view this page, without signing in.'}
							</span>
						</div>
						{#if canShare && !(published && published.pageId !== pageId)}
							<Button
								size="small"
								variant={published ? 'outline' : 'solid'}
								disabled={busy}
								onclick={togglePublish}
								data-testid="publish-toggle"
							>
								{published ? 'Unpublish' : 'Publish'}
							</Button>
						{/if}
					</div>
					{#if published && link}
						<div class="flex items-center gap-1.5">
							<input
								class="h-[var(--app-input-height)] min-w-0 flex-1 rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] px-2.5 text-sm text-[color:var(--app-text-secondary)] outline-none"
								readonly
								aria-label="Public link"
								value={link}
								data-testid="publish-link"
								onfocus={(e) => e.currentTarget.select()}
							/>
							<Button size="small" variant="outline" prefix={copyIcon} onclick={copyLink} data-testid="publish-copy">Copy link</Button>
						</div>
						{#if published.pageId !== pageId}
							<p class="m-0 text-xs text-[color:var(--app-text-tertiary)]">Published through a parent page. Unpublish it from there.</p>
						{/if}
					{:else if !canShare}
						<p class="m-0 text-xs text-[color:var(--app-text-tertiary)]">You need full access to publish this page.</p>
					{/if}
					<p class="m-0 flex items-center gap-1.5 text-xs text-[color:var(--app-text-tertiary)]">
						{@render usersThreeIcon({ size: 14 })}
						<span>Search engines will not index published pages (noindex).</span>
					</p>
				</div>
			{/if}
		</div>
	{/snippet}
</Dialog>
