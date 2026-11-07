<script lang="ts">
	import { Alert } from 'entasis/alert';
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Combobox, type ComboboxItems, type ComboboxOption } from 'entasis/combobox';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Dialog } from 'entasis/dialog';
	import { Select } from 'entasis/select';
	import { Tabs } from 'entasis/tabs';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { copyIcon } from 'entasis/icons/copy';
	import { globeIcon } from 'entasis/icons/globe';
	import { usersThreeIcon } from 'entasis/icons/usersThree';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { inviteGuestToPage, listGrants, publishPage, revokeGrant, setGrant } from '#lib/client/share.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Grant } from '#lib/shared/schemas.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
	import { LEVELS, levelLabel } from '#lib/components/teamspaces/levels.ts';
	import LevelMenu from './LevelMenu.svelte';
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

	const TABS = [
		{ value: 'share', label: 'Share' },
		{ value: 'publish', label: 'Publish' }
	];
	let tab = $state('share');
	let grants = $state.raw<Grant[]>([]);
	let loadState = $state<'loading' | 'ready' | 'error'>('loading');
	let error = $state('');
	let busy = $state(false);

	// invite box
	let query = $state('');
	let picked = $state<string | null>(null);
	let inviteLevel = $state<AccessLevel>('update');

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

	// ── the invite box: people, groups and a typed email, as options of one combobox ──
	const optionOf = (s: Suggestion): ComboboxOption =>
		s.kind === 'user'
			? { value: `user:${s.id}`, label: s.name, description: s.email, data: { suggestion: s } }
			: s.kind === 'teamspace'
				? { value: `teamspace:${s.id}`, label: s.name, description: 'Teamspace', data: { suggestion: s } }
				: { value: `email:${s.email}`, label: `Invite ${s.email}`, description: 'Guest', data: { suggestion: s } };

	// `inviteSuggestions` already filtered by the typed text, so the combobox must not filter again.
	const inviteItems = $derived.by<ComboboxItems>(() => {
		const group = (label: string, kind: Suggestion['kind']) => ({ label, items: suggestions.filter((s) => s.kind === kind).map(optionOf) });
		return [group('People', 'user'), group('Teamspaces', 'teamspace'), group('Invite by email', 'email')].filter((g) => g.items.length);
	});

	async function invite(chosen: Suggestion | undefined = suggestions[0]) {
		if (!chosen || !canShare) return;
		await act(async () => {
			if (chosen.kind === 'email') await inviteGuestToPage({ pageId, email: chosen.email, level: inviteLevel });
			else await setGrant({ pageId, subjectKind: chosen.kind, subjectId: chosen.id, level: inviteLevel });
			if (chosen.kind === 'email') toast.success({ title: 'Invitation sent', description: chosen.email });
		});
		if (!error) query = '';
	}

	function onPick({ option }: { value: string | null; option: ComboboxOption | null }) {
		if (!option) return;
		picked = null; // the box stays a search box: the pick is invited at once
		void invite(option.data?.suggestion as Suggestion);
	}

	const changeLevel = (g: Grant, level: AccessLevel) =>
		act(() => setGrant({ pageId, subjectKind: g.subjectKind, subjectId: g.subjectId, level, ...(g.pending && g.email ? { email: g.email } : {}) }));
	const remove = (g: Grant) => act(() => revokeGrant(g.id));

	function setGeneral(value: string | null) {
		if (!value || value === 'none') {
			if (general && general.pageId === pageId) void act(() => revokeGrant(general.id));
			return;
		}
		if (value === general?.level) return;
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

	// ── the grants table: the owner, the teamspace default, then person, group and invite rows ──
	interface AccessRow {
		id: string;
		subject: string;
		inherited: boolean;
		avatar: { kind: 'user'; name: string } | { kind: 'teamspace'; icon: string | null };
		title: string;
		detail: string;
		/** Static text for a level nobody can change here (owner, teamspace default, inherited). */
		fixed: string | null;
		grant: Grant | null;
		level: AccessLevel | null;
	}

	const accessRows = $derived.by<AccessRow[]>(() => {
		const out: AccessRow[] = [];
		if (creator) {
			out.push({
				id: `owner:${creator.userId}`,
				subject: `owner:${creator.userId}`,
				inherited: false,
				avatar: { kind: 'user', name: creator.name },
				title: `${creator.name}${creator.userId === store.user.id ? ' (you)' : ''}`,
				detail: creator.email,
				fixed: 'Owner',
				grant: null,
				level: null
			});
		}
		if (tsAccess) {
			out.push({
				id: `teamspace-default:${tsAccess.teamspace.id}`,
				subject: `teamspace-default:${tsAccess.teamspace.id}`,
				inherited: false,
				avatar: { kind: 'teamspace', icon: tsAccess.teamspace.icon },
				title: `Everyone in ${tsAccess.teamspace.name}`,
				detail: 'Teamspace access',
				fixed: levelLabel(tsAccess.level),
				grant: null,
				level: null
			});
		}
		for (const r of rows) {
			out.push({
				id: r.key,
				subject: r.kind === 'pending' ? `email:${r.email}` : `${r.kind}:${r.grant.subjectId}`,
				inherited: r.inherited,
				avatar: r.kind === 'teamspace' ? { kind: 'teamspace', icon: store.teamspaces.find((t) => t.id === r.grant.subjectId)?.icon ?? null } : { kind: 'user', name: r.name },
				title: `${r.name}${r.grant.subjectId === store.user.id ? ' (you)' : ''}`,
				detail: r.inherited
					? r.fromPageId && store.page(r.fromPageId)
						? `from ${pageTitle(r.fromPageId)}`
						: 'from parent page'
					: r.kind === 'pending'
						? 'Guest invitation sent'
						: r.kind === 'teamspace'
							? 'Teamspace'
							: (r.email ?? ''),
				fixed: !canShare || r.inherited ? levelLabel(r.level) : null,
				grant: r.grant,
				level: r.level
			});
		}
		return out;
	});

	const columns: DataTableColumn<AccessRow>[] = [
		{ id: 'who', accessor: 'title', header: 'Name', cell: who },
		{ id: 'access', accessor: 'detail', header: 'Access', cell: access, align: 'end' }
	];
	const theme = listTheme({ columns: 'grid-cols-[minmax(0,1fr)_132px]!', edge: 'none', header: false });
	const generalItems = [{ value: 'none', label: 'Only people invited' }, ...LEVELS];
</script>

{#snippet who(p: { row: AccessRow })}
	<span class="flex min-w-0 items-center gap-2 py-0.5">
		{#if p.row.avatar.kind === 'teamspace'}
			<!-- The teamspace emoji has no entasis equivalent (audit section 5, NE-6): Avatar only draws an image or initials. -->
			<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{p.row.avatar.icon ?? '👥'}</span>
		{:else}
			<Avatar size="small" name={p.row.avatar.name} />
		{/if}
		<span class="flex min-w-0 flex-col leading-tight">
			<span class="truncate">{p.row.title}</span>
			<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{p.row.detail}</span>
		</span>
	</span>
{/snippet}

{#snippet access(p: { row: AccessRow })}
	{#if p.row.grant && p.row.level && p.row.fixed === null}
		{@const grant = p.row.grant}
		<LevelMenu
			value={p.row.level}
			label={`Access level of ${p.row.title}`}
			disabled={busy}
			onchange={(l) => changeLevel(grant, l)}
			onremove={() => remove(grant)}
		/>
	{:else}
		<span class="px-2 text-xs text-[color:var(--app-text-secondary)]">{p.row.fixed}</span>
	{/if}
{/snippet}

{#snippet noAccess()}
	<span class="text-xs text-[color:var(--app-text-tertiary)]">Nobody else has access yet.</span>
{/snippet}

{#snippet suggestion(option: ComboboxOption)}
	{@const s = option.data?.suggestion as Suggestion}
	<!-- `w-0 min-w-full`: the option row is shrink-wrapped, so the row must take the list width for `truncate` to work. -->
	<span class="flex w-0 min-w-full items-center gap-2" data-testid="share-suggestion">
		{#if s.kind === 'teamspace'}
			<!-- Teamspace emoji: see NE-6 above. -->
			<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{s.icon ?? '👥'}</span>
		{:else}
			<Avatar size="small" name={s.kind === 'user' ? s.name : s.email} />
		{/if}
		<span class="truncate">{option.label}</span>
		<span class="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs text-[color:var(--app-text-tertiary)]">{option.description}</span>
	</span>
{/snippet}

{#snippet errorAlert()}
	{#if error}
		<div data-testid="share-error">
			<Alert color="danger" variant="soft" size="small">{error}</Alert>
		</div>
	{/if}
{/snippet}

{#snippet sharePanel()}
	<div class="flex flex-col gap-3 pt-1">
		{@render errorAlert()}

		{#if canShare}
			<div class="flex items-center gap-1.5">
				<div class="min-w-0 flex-1" data-testid="share-invite-input">
					<Combobox
						label="Invite people"
						theme={{ label: { base: 'sr-only' } }}
						placeholder="Add people, groups or emails"
						bind:searchValue={query}
						bind:value={picked}
						items={inviteItems}
						item={suggestion}
						filter={() => true}
						noOptionsText="No match. Type a full email address to invite a guest."
						onValueChange={onPick}
					/>
				</div>
				<LevelMenu value={inviteLevel} label="Access level of the invitation" variant="outline" onchange={(l) => (inviteLevel = l)} testid="share-invite-level" />
				<Button size="small" disabled={busy || !suggestions[0]} onclick={() => invite()} data-testid="share-invite-submit">Invite</Button>
			</div>
		{:else if page}
			<p class="m-0 text-xs text-[color:var(--app-text-tertiary)]" data-testid="share-readonly">
				{store.canEdit ? 'You need full access to share this page.' : 'Sharing needs a connection.'}
			</p>
		{/if}

		{#if loadState === 'error' && !grants.length}
			<Alert color="danger" variant="soft" size="small">
				<span class="flex items-center gap-2">
					<span>Could not load who has access.</span>
					<Button variant="ghost" size="small" onclick={() => refresh(pageId, true)}>Retry</Button>
				</span>
			</Alert>
		{:else}
			<DataTable
				items={accessRows}
				{columns}
				getRowId={(r) => r.id}
				density="compact"
				pagination={false}
				loading={loadState === 'loading'}
				empty={noAccess}
				caption="People with access"
				{theme}
				getRowAttrs={(r) => ({ 'data-testid': 'share-grant-row', 'data-subject': r.subject, 'data-inherited': String(r.inherited) })}
			/>

			<div class="border-t border-[color:var(--app-hairline)] pt-2">
				<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">General access</h3>
				<div class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="share-general-row">
					<Avatar size="small" name={store.workspace.name} />
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
					<div class="w-40 shrink-0">
						<Select
							size="small"
							items={generalItems}
							value={general?.level ?? 'none'}
							onValueChange={setGeneral}
							alignItemWithTrigger={false}
							disabled={!canShare || busy || (!!general && general.pageId !== pageId)}
							triggerAttrs={{ 'aria-label': 'General access', 'data-testid': 'share-general' }}
						/>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet publishPanel()}
	<div class="flex flex-col gap-3 pt-1" data-testid="publish-panel">
		{@render errorAlert()}
		<div class="flex items-start gap-3">
			<span class="grid size-8 shrink-0 place-items-center text-[color:var(--app-text-secondary)]">
				{@render globeIcon({ size: 20 })}
			</span>
			<div class="flex min-w-0 flex-1 flex-col text-sm">
				<span class="font-medium">{published ? 'This page is published' : 'Publish to the web'}</span>
				<span class="text-xs text-[color:var(--app-text-secondary)]">
					{published ? 'Anyone with the link can view it, without signing in.' : 'Anyone with the link will be able to view this page, without signing in.'}
				</span>
			</div>
			{#if canShare && !(published && published.pageId !== pageId)}
				<Button size="small" variant={published ? 'outline' : 'solid'} disabled={busy} onclick={togglePublish} data-testid="publish-toggle">
					{published ? 'Unpublish' : 'Publish'}
				</Button>
			{/if}
		</div>
		{#if published && link}
			<TextInput readOnly value={link} inputAttrs={{ 'aria-label': 'Public link', 'data-testid': 'publish-link', onfocus: (e) => e.currentTarget.select() }}>
				{#snippet suffix()}
					<Button size="small" variant="ghost" prefix={copyIcon} onclick={copyLink} data-testid="publish-copy">Copy link</Button>
				{/snippet}
			</TextInput>
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
{/snippet}

<Dialog bind:open size="small" closable>
	{#snippet title()}Share{#if page}<span class="ml-2 font-normal text-[color:var(--app-text-secondary)]">{page.title || 'Untitled'}</span>{/if}{/snippet}
	{#snippet children()}
		<div class="pb-2" data-testid="share-dialog" data-page-id={pageId}>
			<Tabs items={TABS} value={tab} onValueChange={({ value }) => (tab = value)} tabbar={{ size: 'small', variant: 'underline', label: 'Share options' }}>
				{#snippet children({ item })}
					{#if (typeof item === 'string' ? item : item.value) === 'share'}
						{@render sharePanel()}
					{:else}
						{@render publishPanel()}
					{/if}
				{/snippet}
			</Tabs>
		</div>
	{/snippet}
</Dialog>
