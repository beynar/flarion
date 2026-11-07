<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import { toast } from 'entasis/toast';
	import { plusIcon } from 'entasis/icons/plus';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import type { ArchivedTeamspace, Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import CreateTeamspaceDialog from '#lib/components/teamspaces/CreateTeamspaceDialog.svelte';
	import TeamspaceSettingsDialog from '#lib/components/teamspaces/TeamspaceSettingsDialog.svelte';
	import { joinAction, splitTeamspaces } from '#lib/components/teamspaces/logic.ts';
	import { privacyLabel } from '#lib/components/teamspaces/levels.ts';

	const store = useWorkspace();

	let loading = $state(true);
	let createOpen = $state(false);
	let settingsId = $state<string | null>(null);
	let settingsOpen = $state(false);
	let joining = $state<string | null>(null);
	let rosters = $state.raw<Record<string, TeamspaceMember[]>>({});
	let archived = $state.raw<ArchivedTeamspace[]>([]);
	let restoring = $state<string | null>(null);

	const lists = $derived(splitTeamspaces(store.teamspaces, store.myTeamspaces));
	const nameOf = (id: string) => store.members.find((m) => m.userId === id)?.name ?? 'Someone';
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
		await store.refreshDirectory();
		loading = false;
		await Promise.all([loadRosters(), loadArchived()]);
	});

	// Memberships changed elsewhere in the app (joined, left, archived): keep the counts in step.
	$effect(() => {
		void store.teamspaces;
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
</script>

{#snippet row(ts: Teamspace)}
	{@const action = joinAction(ts)}
	{@const owners = ownersOf(ts.id)}
	<li
		class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm"
		style="min-height: var(--app-table-row-height); padding-block: 4px"
		data-testid="teamspace-row"
		data-teamspace-id={ts.id}
	>
		<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{ts.icon ?? '👥'}</span>
		<span class="flex min-w-0 flex-1 flex-col leading-snug">
			<span class="truncate font-medium">{ts.name}</span>
			{#if ts.description}
				<span class="truncate text-xs text-[color:var(--app-text-secondary)]">{ts.description}</span>
			{:else if action === 'request' && owners.length}
				<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">Owner{owners.length > 1 ? 's' : ''}: {owners.join(', ')}</span>
			{/if}
		</span>
		<span class="hidden w-20 shrink-0 text-right text-xs text-[color:var(--app-text-tertiary)] md:inline">
			{#if rosters[ts.id]}{rosters[ts.id].length} member{rosters[ts.id].length === 1 ? '' : 's'}{/if}
		</span>
		<span class="hidden w-16 shrink-0 md:inline"><OptionTag color={ts.privacy === 'open' ? 'green' : ts.privacy === 'closed' ? 'orange' : 'gray'} label={privacyLabel(ts.privacy)} /></span>
		<span class="flex shrink-0 items-center justify-end gap-1 md:w-[176px]">
			{#if action === 'member'}
				<span class="hidden w-14 shrink-0 text-xs text-[color:var(--app-text-secondary)] lg:inline">{ts.myRole === 'owner' ? 'Owner' : 'Member'}</span>
				<Button variant="ghost" size="small" onclick={() => openSettings(ts.id)} data-testid="teamspace-settings">Settings</Button>
			{:else}
				{#if action === 'join'}
					<Button size="small" loading={joining === ts.id} onclick={() => join(ts)} data-testid="teamspace-join">Join</Button>
				{:else if action === 'request'}
					<span title="Ask an owner to add you">
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
	</li>
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

	{#if loading && !store.teamspaces.length}
		<div class="flex flex-col gap-2" aria-busy="true">
			{#each [1, 2, 3] as i (i)}<div class="h-9 animate-pulse rounded bg-[color:var(--app-hover)]"></div>{/each}
		</div>
	{:else}
		<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Your teamspaces</h3>
		<ul class="m-0 mb-8 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0" data-testid="my-teamspaces">
			{#each lists.mine as ts (ts.id)}{@render row(ts)}{:else}
				<li class="py-3 text-sm text-[color:var(--app-text-tertiary)]">You are not in a teamspace yet. Join one below or create your own.</li>
			{/each}
		</ul>

		<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Browse teamspaces</h3>
		<ul class="m-0 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0" data-testid="browse-teamspaces">
			{#each lists.browse as ts (ts.id)}{@render row(ts)}{:else}
				<li class="py-3 text-sm text-[color:var(--app-text-tertiary)]">No other teamspaces to join.</li>
			{/each}
		</ul>

		{#if archived.length}
			<h3 class="mt-8 mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Archived teamspaces</h3>
			<ul class="m-0 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0" data-testid="archived-teamspaces">
				{#each archived as ts (ts.id)}
					<li
						class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm"
						style="min-height: var(--app-table-row-height); padding-block: 4px"
						data-testid="archived-teamspace-row"
						data-teamspace-id={ts.id}
					>
						<span class="grid size-6 shrink-0 place-items-center text-lg leading-none">{ts.icon ?? '👥'}</span>
						<span class="flex min-w-0 flex-1 flex-col leading-snug">
							<span class="truncate font-medium">{ts.name}</span>
							<span class="truncate text-xs text-[color:var(--app-text-secondary)]">
								Archived {new Date(ts.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, {ts.pageCount} page{ts.pageCount === 1 ? '' : 's'} (deleted for good after 30 days)
							</span>
						</span>
						<Button variant="outline" size="small" loading={restoring === ts.id} onclick={() => restore(ts)} data-testid="teamspace-restore">Restore</Button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<CreateTeamspaceDialog {store} bind:open={createOpen} onCreated={(ts) => toast.success({ title: `Created ${ts.name}` })} />
<TeamspaceSettingsDialog {store} teamspaceId={settingsId} bind:open={settingsOpen} />
