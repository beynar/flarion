<script lang="ts">
	import { Alert } from 'entasis/alert';
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { Combobox, type ComboboxOption } from 'entasis/combobox';
	import { confirmation } from 'entasis/confirmation';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Dialog } from 'entasis/dialog';
	import { Select } from 'entasis/select';
	import { tooltip } from 'entasis/tooltip';
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';
	import IconPicker from '#lib/components/pickers/IconPicker.svelte';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
	import { LEVELS, PRIVACY_OPTIONS } from './levels.ts';
	import { canManageTeamspace, isLastOwner, memberCandidates, sortTeamspaceMembers } from './logic.ts';

	let {
		store,
		teamspaceId,
		open = $bindable(false),
		onArchived
	}: {
		store: WorkspaceStore;
		teamspaceId: string | null;
		open: boolean;
		onArchived?: () => void;
	} = $props();

	const ts = $derived(teamspaceId ? store.teamspaces.find((t) => t.id === teamspaceId) : undefined);
	const canManage = $derived(ts ? canManageTeamspace(ts, store.isAdmin) : false);

	let members = $state.raw<TeamspaceMember[]>([]);
	let membersState = $state<'loading' | 'ready' | 'error'>('loading');
	let name = $state('');
	let description = $state('');
	let query = $state('');
	let picked = $state<string | null>(null);
	let error = $state('');

	const names = $derived(new Map(store.members.map((m) => [m.userId, m.name])));
	const person = (id: string) => store.members.find((m) => m.userId === id);
	const sorted = $derived(sortTeamspaceMembers(members, names));
	const candidates = $derived(memberCandidates(store.members, members, query));

	// Load the members and reset the form when the dialog opens on a teamspace.
	$effect(() => {
		const id = teamspaceId;
		if (!open || !id) return;
		name = ts?.name ?? '';
		description = ts?.description ?? '';
		query = '';
		error = '';
		void loadMembers(id);
	});

	async function loadMembers(id: string) {
		membersState = 'loading';
		try {
			members = await store.teamspaceMembers(id);
			membersState = 'ready';
		} catch {
			membersState = 'error';
		}
	}

	async function update(patch: Omit<Parameters<WorkspaceStore['updateTeamspace']>[0], 'id'>) {
		if (!ts) return;
		try {
			await store.updateTeamspace({ id: ts.id, ...patch });
		} catch {
			name = ts.name;
			description = ts.description;
		}
	}

	const commitName = () => {
		const next = name.trim();
		if (!ts || !next) name = ts?.name ?? '';
		else if (next !== ts.name) void update({ name: next });
	};
	const commitDescription = () => {
		if (ts && description.trim() !== ts.description) void update({ description: description.trim() });
	};

	async function run(action: () => Promise<unknown>) {
		error = '';
		try {
			await action();
			if (teamspaceId) await loadMembers(teamspaceId);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const candidateOptions = $derived<ComboboxOption[]>(candidates.map((c) => ({ value: c.userId, label: c.name, description: c.email })));

	function onPick({ value }: { value: string | null }) {
		if (!value) return;
		picked = null; // the box stays a search box: the pick is added at once
		void run(() => store.addTeamspaceMember(ts!.id, value));
	}

	async function leave() {
		if (!ts) return;
		await run(() => store.removeTeamspaceMember(ts.id, store.user.id));
		open = false;
	}

	async function archive() {
		if (!ts) return;
		const target = ts;
		const outcome = await confirmation({
			title: `Archive ${target.name}?`,
			description:
				'The teamspace and every page in it are archived. Members lose access to them until an owner restores the teamspace from Settings, and everything is deleted for good after 30 days.',
			confirm: { text: 'Archive teamspace', color: 'danger', 'data-testid': 'teamspace-archive-confirm' },
			cancel: 'Cancel',
			// Resolves false when the store has already raised its toast: the dialog stays on the teamspace.
			onConfirm: () =>
				store.archiveTeamspace(target.id).then(
					() => true,
					() => false
				)
		});
		if (outcome.confirmed && outcome.result) {
			open = false;
			onArchived?.();
		}
	}

	const mineLast = $derived(isLastOwner(members, store.user.id));

	// ── the members table ──
	const columns: DataTableColumn<TeamspaceMember>[] = [
		{ id: 'who', accessor: (m) => person(m.userId)?.name ?? m.userId, header: 'Member', cell: who },
		{ id: 'role', accessor: 'role', header: 'Role', cell: role, align: 'end' },
		{ id: 'action', accessor: 'userId', header: '', cell: action, align: 'end' }
	];
	const theme = listTheme({ columns: 'grid-cols-[minmax(0,1fr)_112px_76px]!', edge: 'none', header: false });
	const ROLE_ITEMS = [
		{ value: 'owner', label: 'Owner' },
		{ value: 'member', label: 'Member' }
	];
</script>

{#snippet who(p: { row: TeamspaceMember })}
	{@const person_ = person(p.row.userId)}
	<span class="flex min-w-0 items-center gap-2 py-0.5">
		<Avatar size="small" name={person_?.name ?? p.row.userId} />
		<span class="flex min-w-0 flex-col leading-tight">
			<span class="truncate">{person_?.name ?? 'Someone'}{p.row.userId === store.user.id ? ' (you)' : ''}</span>
			{#if person_}<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{person_.email}</span>{/if}
		</span>
	</span>
{/snippet}

{#snippet role(p: { row: TeamspaceMember })}
	{@const lastOwner = isLastOwner(members, p.row.userId)}
	{#if canManage}
		<span class="block w-full" {@attach tooltip({ content: 'A teamspace needs at least one owner', disabled: !lastOwner })}>
			<Select
				size="small"
				items={ROLE_ITEMS}
				value={p.row.role}
				disabled={lastOwner}
				alignItemWithTrigger={false}
				onValueChange={(next) => next && next !== p.row.role && run(() => store.setTeamspaceMemberRole(ts!.id, p.row.userId, next as 'owner' | 'member'))}
				triggerAttrs={{ 'aria-label': `Role of ${person(p.row.userId)?.name ?? p.row.userId}` }}
			/>
		</span>
	{:else}
		<Chip size="small" variant="soft" color={p.row.role === 'owner' ? 'primary' : 'neutral'}>{p.row.role === 'owner' ? 'Owner' : 'Member'}</Chip>
	{/if}
{/snippet}

{#snippet action(p: { row: TeamspaceMember })}
	{@const self = p.row.userId === store.user.id}
	{#if canManage || self}
		<Button
			variant="ghost"
			size="small"
			color="danger"
			disabled={isLastOwner(members, p.row.userId)}
			onclick={() => (self ? leave() : run(() => store.removeTeamspaceMember(ts!.id, p.row.userId)))}
		>
			{self ? 'Leave' : 'Remove'}
		</Button>
	{/if}
{/snippet}

{#snippet candidate(option: ComboboxOption)}
	<!-- `w-0 min-w-full`: the option row is shrink-wrapped, so the row must take the list width for `truncate` to work. -->
	<span class="flex w-0 min-w-full items-center gap-2" data-testid="teamspace-candidate">
		<Avatar size="small" name={option.label} />
		<span class="truncate">{option.label}</span>
		<span class="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-xs text-[color:var(--app-text-tertiary)]">{option.description}</span>
	</span>
{/snippet}

<Dialog bind:open size="small" closable>
	{#snippet title()}{ts?.name ?? 'Teamspace'} settings{/snippet}
	{#snippet children()}
		{#if ts}
			<div class="flex flex-col gap-5 pt-1 pb-3" data-testid="teamspace-settings-dialog" data-teamspace-id={ts.id}>
				<section class="flex flex-col gap-3" aria-label="General">
					<div class="flex items-end gap-2">
						{#if canManage}
							<IconPicker current={ts.icon} onpick={(icon) => update({ icon })}>
								{#snippet button({ attach })}
									<!-- The teamspace emoji is not an entasis Avatar (image or initials only): it is the button's content. -->
									<Button variant="outline" squared class="size-[var(--app-input-height)] shrink-0 text-xl" label="Change icon" {@attach attach}>
										{ts.icon ?? '👥'}
									</Button>
								{/snippet}
							</IconPicker>
						{:else}
							<span class="grid size-[var(--app-input-height)] shrink-0 place-items-center text-xl">{ts.icon ?? '👥'}</span>
						{/if}
						<div class="min-w-0 flex-1" onfocusout={commitName}>
							<TextInput label="Name" bind:value={name} readOnly={!canManage} inputAttrs={{ 'data-testid': 'teamspace-settings-name', maxlength: 100 }} />
						</div>
					</div>
					<div onfocusout={commitDescription}>
						<TextArea label="Description" rows={2} value={description} onValueChange={(v) => (description = v ?? '')} readOnly={!canManage} maxLength={1000} />
					</div>
					<div class="flex items-center justify-between gap-3 text-sm">
						<span class="flex flex-col">
							<span class="font-medium">Privacy</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">{PRIVACY_OPTIONS.find((p) => p.value === ts.privacy)?.hint}</span>
						</span>
						<div class="w-32 shrink-0">
							<Select
								size="small"
								items={PRIVACY_OPTIONS}
								value={ts.privacy}
								disabled={!canManage}
								alignItemWithTrigger={false}
								onValueChange={(v) => v && v !== ts.privacy && update({ privacy: v as Teamspace['privacy'] })}
								triggerAttrs={{ 'aria-label': 'Privacy', 'data-testid': 'teamspace-settings-privacy' }}
							/>
						</div>
					</div>
					<div class="flex items-center justify-between gap-3 text-sm">
						<span class="flex flex-col">
							<span class="font-medium">Default access</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">What members can do on the teamspace's pages.</span>
						</span>
						<div class="w-40 shrink-0">
							<Select
								size="small"
								items={LEVELS}
								value={ts.defaultLevel}
								disabled={!canManage}
								alignItemWithTrigger={false}
								onValueChange={(v) => v && v !== ts.defaultLevel && update({ defaultLevel: v as AccessLevel })}
								triggerAttrs={{ 'aria-label': 'Default access of members', 'data-testid': 'teamspace-settings-level' }}
							/>
						</div>
					</div>
				</section>

				<section aria-label="Members">
					<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Members{membersState === 'ready' ? ` · ${members.length}` : ''}</h3>
					{#if canManage}
						<div class="mb-2" data-testid="teamspace-add-member">
							<Combobox
								label="Add a member"
								theme={{ label: { base: 'sr-only' } }}
								placeholder="Add a workspace member…"
								prefix={false}
								bind:searchValue={query}
								bind:value={picked}
								items={candidateOptions}
								item={candidate}
								filter={() => true}
								openOnFocus
								noOptionsText="Everyone in the workspace is already a member."
								onValueChange={onPick}
							/>
						</div>
					{/if}
					{#if membersState === 'error'}
						<Alert color="danger" variant="soft" size="small">Could not load the members.</Alert>
					{:else}
						<DataTable
							items={sorted}
							{columns}
							getRowId={(m) => m.userId}
							density="compact"
							pagination={false}
							loading={membersState === 'loading'}
							caption="Members"
							{theme}
							getRowAttrs={(m) => ({ 'data-testid': 'teamspace-member-row', 'data-user-id': m.userId })}
						/>
						{#if mineLast && !canManage}
							<p class="mt-1 text-xs text-[color:var(--app-text-tertiary)]">You are the only owner.</p>
						{/if}
					{/if}
					{#if error}
						<div class="mt-2"><Alert color="danger" variant="soft" size="small">{error}</Alert></div>
					{/if}
				</section>

				{#if canManage}
					<section class="flex items-center justify-between gap-3 border-t border-[color:var(--app-hairline)] pt-3" aria-label="Danger zone">
						<span class="flex flex-col text-sm">
							<span class="font-medium">Archive teamspace</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">Archives the teamspace and all its pages. An owner can restore it from Settings within 30 days.</span>
						</span>
						<Button variant="outline" color="danger" size="small" onclick={archive} data-testid="teamspace-archive">Archive</Button>
					</section>
				{/if}
			</div>
		{/if}
	{/snippet}
</Dialog>
