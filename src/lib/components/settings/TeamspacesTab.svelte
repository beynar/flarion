<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Empty } from 'entasis/empty';
	import { tooltip } from 'entasis/tooltip';
	import { toast } from 'entasis/toast';
	import { plusIcon } from 'entasis/icons/plus';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import type { ArchivedTeamspace, Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
	import CreateTeamspaceDialog from '#lib/components/teamspaces/CreateTeamspaceDialog.svelte';
	import TeamspaceSettingsDialog from '#lib/components/teamspaces/TeamspaceSettingsDialog.svelte';
	import { joinAction, splitTeamspaces } from '#lib/components/teamspaces/logic.ts';
	import { privacyLabel } from '#lib/components/teamspaces/levels.ts';

	const store = useWorkspace();

	let { initial = null }: { initial?: { rosters: Record<string, TeamspaceMember[]>; archived: ArchivedTeamspace[] } | null } = $props();

	// The server render read the rosters and the archived teamspaces: on screen from the first paint, and not asked for again.
	let loading = $state(untrack(() => !initial));
	let createOpen = $state(false);
	let settingsId = $state<string | null>(null);
	let settingsOpen = $state(false);
	let joining = $state<string | null>(null);
	let rosters = $state.raw<Record<string, TeamspaceMember[]>>(untrack(() => initial?.rosters ?? {}));
	let archived = $state.raw<ArchivedTeamspace[]>(untrack(() => initial?.archived ?? []));
	let restoring = $state<string | null>(null);

	const lists = $derived(splitTeamspaces(store.teamspaces, store.myTeamspaces));
	const nameOf = (id: string) => store.members.find((m) => m.userId === id)?.name ?? 'Deleted user';
	const ownersOf = (id: string) => (rosters[id] ?? []).filter((m) => m.role === 'owner').map((m) => nameOf(m.userId));

	async function loadRosters() {
		const list = store.teamspaces;
		const results = await Promise.allSettled(list.map((t) => store.teamspaceMembers(t.id)));
		const next: Record<string, TeamspaceMember[]> = {};
		results.forEach((r, i) => {
			if (r.status === 'fulfilled') next[list[i].id] = r.value;
		});
		rosters = next;
	}

	/** Archived teamspaces are not in Trash: the ones I own are listed here, with a restore button. */
	async function loadArchived() {
		try {
			archived = await store.archivedTeamspaces();
		} catch {
			archived = [];
		}
	}

	onMount(async () => {
		if (initial) return;
		await store.refreshDirectory();
		loading = false;
		await Promise.all([loadRosters(), loadArchived()]);
	});

	// Memberships changed elsewhere in the app (joined, left, archived): keep the counts in step.
	let fromServer = untrack(() => !!initial);
	$effect(() => {
		void store.teamspaces;
		if (fromServer) {
			fromServer = false;
			return;
		}
		if (!loading) void Promise.all([loadRosters(), loadArchived()]);
	});

	async function restore(ts: ArchivedTeamspace) {
		restoring = ts.id;
		try {
			await store.restoreTeamspace(ts.id);
			toast.success({ title: `Restored ${ts.name}` });
			await loadArchived();
		} catch {
			// the store has raised the toast
		} finally {
			restoring = null;
		}
	}

	async function join(ts: Teamspace) {
		joining = ts.id;
		try {
			await store.addTeamspaceMember(ts.id);
			toast.success({ title: `Joined ${ts.name}` });
		} catch {
			// the store has raised the toast
		} finally {
			joining = null;
		}
	}

	const openSettings = (id: string) => {
		settingsId = id;
		settingsOpen = true;
	};

	const privacyColor = (privacy: Teamspace['privacy']) => (privacy === 'open' ? 'success' : privacy === 'closed' ? 'warning' : 'neutral');

	const columns: DataTableColumn<Teamspace>[] = [
		{ id: 'teamspace', accessor: 'name', header: 'Teamspace', cell: nameCell },
		{ id: 'members', accessor: (ts) => rosters[ts.id]?.length ?? 0, header: 'Members', cell: membersCell, align: 'end', class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'privacy', accessor: 'privacy', header: 'Privacy', cell: privacyCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'actions', accessor: 'id', header: '', cell: actionsCell, align: 'end' }
	];
	const archivedColumns: DataTableColumn<ArchivedTeamspace>[] = [
		{ id: 'teamspace', accessor: 'name', header: 'Archived teamspaces', cell: archivedCell },
		{ id: 'actions', accessor: 'id', header: '', cell: restoreCell, align: 'end' }
	];
	const theme = listTheme({
		columns: 'max-md:grid-cols-[minmax(0,1fr)_204px]! md:grid-cols-[minmax(0,1fr)_96px_96px_232px]!',
		rowClass: 'py-1'
	});
	const archivedTheme = listTheme({ columns: 'grid-cols-[minmax(0,1fr)_104px]!', rowClass: 'py-1' });
</script>

{#snippet nameCell(p: { row: Teamspace })}
	{@const ts = p.row}
	{@const owners = ownersOf(ts.id)}
	<span class="flex min-w-0 items-center gap-3">
		<!-- The teamspace emoji has no entasis equivalent (audit section 5, NE-6): Avatar only draws an image or initials. -->
		<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{ts.icon ?? '👥'}</span>
		<span class="flex min-w-0 flex-col leading-snug">
			<span class="truncate font-medium">{ts.name}</span>
			{#if ts.description}
				<span class="truncate text-xs text-[color:var(--app-text-secondary)]">{ts.description}</span>
			{:else if joinAction(ts) === 'request' && owners.length}
				<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">Owner{owners.length > 1 ? 's' : ''}: {owners.join(', ')}</span>
			{/if}
		</span>
	</span>
{/snippet}

{#snippet membersCell(p: { row: Teamspace })}
	<span class="text-xs text-[color:var(--app-text-tertiary)]">
		{#if rosters[p.row.id]}{rosters[p.row.id].length} member{rosters[p.row.id].length === 1 ? '' : 's'}{/if}
	</span>
{/snippet}

{#snippet privacyCell(p: { row: Teamspace })}
	<Chip size="small" variant="soft" color={privacyColor(p.row.privacy)}>{privacyLabel(p.row.privacy)}</Chip>
{/snippet}

{#snippet actionsCell(p: { row: Teamspace })}
	{@const ts = p.row}
	{@const action = joinAction(ts)}
	<span class="flex items-center justify-end gap-1">
		{#if action === 'member'}
			<span class="hidden text-xs text-[color:var(--app-text-secondary)] lg:inline">{ts.myRole === 'owner' ? 'Owner' : 'Member'}</span>
			<Button variant="ghost" size="small" onclick={() => openSettings(ts.id)} data-testid="teamspace-settings">Settings</Button>
		{:else}
			{#if action === 'join'}
				<Button size="small" loading={joining === ts.id} onclick={() => join(ts)} data-testid="teamspace-join">Join</Button>
			{:else if action === 'request'}
				<span {@attach tooltip({ content: 'Ask an owner to add you' })}>
					<Button variant="outline" size="small" disabled data-testid="teamspace-request">Request access</Button>
				</span>
			{:else}
				<span class="text-xs text-[color:var(--app-text-tertiary)]">Invite only</span>
			{/if}
			{#if store.isAdmin}
				<Button variant="ghost" size="small" onclick={() => openSettings(ts.id)}>Settings</Button>
			{/if}
		{/if}
	</span>
{/snippet}

{#snippet archivedCell(p: { row: ArchivedTeamspace })}
	<span class="flex min-w-0 items-center gap-3">
		<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{p.row.icon ?? '👥'}</span>
		<span class="flex min-w-0 flex-col leading-snug">
			<span class="truncate font-medium">{p.row.name}</span>
			<span class="truncate text-xs text-[color:var(--app-text-secondary)]">
				Archived {new Date(p.row.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, {p.row.pageCount} page{p.row.pageCount === 1 ? '' : 's'} (deleted for good after 30 days)
			</span>
		</span>
	</span>
{/snippet}

{#snippet restoreCell(p: { row: ArchivedTeamspace })}
	<Button variant="outline" size="small" loading={restoring === p.row.id} onclick={() => restore(p.row)} data-testid="teamspace-restore">Restore</Button>
{/snippet}

{#snippet noneMine()}
	<Empty size="small" title="You are not in a teamspace yet. Join one below or create your own." />
{/snippet}

{#snippet noneBrowse()}
	<Empty size="small" title="No other teamspaces to join." />
{/snippet}

<section aria-labelledby="teamspaces-h" data-testid="teamspaces-tab">
	<div class="mb-4 flex items-start gap-3">
		<div class="flex-1">
			<h2 id="teamspaces-h" class="mb-1 text-base font-semibold">Teamspaces</h2>
			<p class="text-sm text-[color:var(--app-text-secondary)]">
				A teamspace is a shared home for a team's pages. Members get the teamspace's default access on every page in it.
			</p>
		</div>
		<Button size="small" prefix={plusIcon} onclick={() => (createOpen = true)} disabled={!store.canEdit || store.workspace.role === 'guest'} data-testid="new-teamspace">New teamspace</Button>
	</div>

	<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Your teamspaces</h3>
	<div class="mb-8" data-testid="my-teamspaces">
		<DataTable
			items={lists.mine}
			{columns}
			getRowId={(ts) => ts.id}
			density="compact"
			pagination={false}
			loading={loading && !store.teamspaces.length}
			empty={noneMine}
			caption="Your teamspaces"
			{theme}
			getRowAttrs={(ts) => ({ 'data-testid': 'teamspace-row', 'data-teamspace-id': ts.id })}
		/>
	</div>

	<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Browse teamspaces</h3>
	<div data-testid="browse-teamspaces">
		<DataTable
			items={lists.browse}
			{columns}
			getRowId={(ts) => ts.id}
			density="compact"
			pagination={false}
			loading={loading && !store.teamspaces.length}
			empty={noneBrowse}
			caption="Browse teamspaces"
			{theme}
			getRowAttrs={(ts) => ({ 'data-testid': 'teamspace-row', 'data-teamspace-id': ts.id })}
		/>
	</div>

	{#if archived.length}
		<div class="mt-8" data-testid="archived-teamspaces">
			<DataTable
				items={archived}
				columns={archivedColumns}
				getRowId={(ts) => ts.id}
				density="compact"
				pagination={false}
				caption="Archived teamspaces"
				theme={archivedTheme}
				getRowAttrs={(ts) => ({ 'data-testid': 'archived-teamspace-row', 'data-teamspace-id': ts.id })}
			/>
		</div>
	{/if}
</section>

<CreateTeamspaceDialog {store} bind:open={createOpen} onCreated={(ts) => toast.success({ title: `Created ${ts.name}` })} />
<TeamspaceSettingsDialog {store} teamspaceId={settingsId} bind:open={settingsOpen} />
