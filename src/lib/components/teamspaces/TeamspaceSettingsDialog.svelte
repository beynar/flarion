<script lang="ts">
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';
	import IconPicker from '#lib/components/pickers/IconPicker.svelte';
	import LevelSelect from '#lib/components/share/LevelSelect.svelte';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import { PRIVACY_OPTIONS } from './levels.ts';
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
	let pickerOpen = $state(false);
	let confirmOpen = $state(false);
	let busy = $state(false);
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

	const add = (userId: string) => {
		query = '';
		pickerOpen = false;
		return run(() => store.addTeamspaceMember(ts!.id, userId));
	};

	async function leave() {
		if (!ts) return;
		await run(() => store.removeTeamspaceMember(ts.id, store.user.id));
		open = false;
	}

	async function archive() {
		if (!ts) return;
		busy = true;
		try {
			await store.archiveTeamspace(ts.id);
			confirmOpen = false;
			open = false;
			onArchived?.();
		} catch {
			// the store has raised the toast
		} finally {
			busy = false;
		}
	}

	const mineLast = $derived(isLastOwner(members, store.user.id));
</script>

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
									<button
										type="button"
										class="grid size-[var(--app-input-height)] shrink-0 place-items-center rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] text-xl hover:bg-[color:var(--app-hover)]"
										aria-label="Change icon"
										{@attach attach}
									>
										{ts.icon ?? '👥'}
									</button>
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
						<select
							class="h-[var(--app-button-height-small)] rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline)] bg-transparent px-1.5 text-sm disabled:appearance-none disabled:border-transparent"
							aria-label="Privacy"
							data-testid="teamspace-settings-privacy"
							disabled={!canManage}
							value={ts.privacy}
							onchange={(e) => update({ privacy: e.currentTarget.value as Teamspace['privacy'] })}
						>
							{#each PRIVACY_OPTIONS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
						</select>
					</div>
					<div class="flex items-center justify-between gap-3 text-sm">
						<span class="flex flex-col">
							<span class="font-medium">Default access</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">What members can do on the teamspace's pages.</span>
						</span>
						<LevelSelect
							value={ts.defaultLevel}
							label="Default access of members"
							disabled={!canManage}
							onchange={(level: AccessLevel) => update({ defaultLevel: level })}
							testid="teamspace-settings-level"
						/>
					</div>
				</section>

				<section aria-label="Members">
					<h3 class="mb-1 text-xs font-medium text-[color:var(--app-text-tertiary)]">Members{membersState === 'ready' ? ` · ${members.length}` : ''}</h3>
					{#if canManage}
						<div class="relative mb-2">
							<input
								class="h-[var(--app-input-height)] w-full rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] px-2.5 text-sm outline-none focus:border-[color:var(--app-accent)]"
								placeholder="Add a workspace member…"
								aria-label="Add a member"
								role="combobox"
								aria-expanded={pickerOpen && candidates.length > 0}
								aria-controls="ts-candidates"
								data-testid="teamspace-add-member"
								bind:value={query}
								onfocus={() => (pickerOpen = true)}
								oninput={() => (pickerOpen = true)}
								onblur={() => setTimeout(() => (pickerOpen = false), 120)}
								onkeydown={(e) => {
									if (e.key === 'Enter' && candidates[0]) {
										e.preventDefault();
										void add(candidates[0].userId);
									}
								}}
							/>
							{#if pickerOpen && candidates.length}
								<ul
									id="ts-candidates"
									role="listbox"
									class="absolute top-full right-0 left-0 z-20 m-0 mt-1 max-h-48 list-none overflow-y-auto rounded-[var(--app-radius-panel)] bg-[color:var(--surface-floating,var(--app-page))] p-1"
									style="box-shadow: var(--app-shadow-menu)"
								>
									{#each candidates as c (c.userId)}
										<li role="option" aria-selected="false">
											<button
												type="button"
												class="flex h-[var(--app-row-height)] w-full items-center gap-2 rounded px-1.5 text-left text-sm hover:bg-[color:var(--app-hover)]"
												data-testid="teamspace-candidate"
												onmousedown={(e) => e.preventDefault()}
												onclick={() => add(c.userId)}
											>
												<Avatar size="small" name={c.name} />
												<span class="truncate">{c.name}</span>
												<span class="ml-auto truncate text-xs text-[color:var(--app-text-tertiary)]">{c.email}</span>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
					{#if membersState === 'loading'}
						<div class="flex flex-col gap-1" aria-busy="true">
							{#each [1, 2] as i (i)}<div class="h-8 animate-pulse rounded bg-[color:var(--app-hover)]"></div>{/each}
						</div>
					{:else if membersState === 'error'}
						<p class="text-sm text-[color:var(--app-danger)]">Could not load the members.</p>
					{:else}
						<ul class="m-0 flex list-none flex-col p-0">
							{#each sorted as m (m.userId)}
								{@const p = person(m.userId)}
								{@const self = m.userId === store.user.id}
								{@const lastOwner = isLastOwner(members, m.userId)}
								<li class="flex items-center gap-2 text-sm" style="min-height: var(--app-table-row-height)" data-testid="teamspace-member-row" data-user-id={m.userId}>
									<Avatar size="small" name={p?.name ?? m.userId} />
									<span class="flex min-w-0 flex-1 flex-col leading-tight">
										<span class="truncate">{p?.name ?? 'Someone'}{self ? ' (you)' : ''}</span>
										{#if p}<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{p.email}</span>{/if}
									</span>
									{#if canManage}
										<select
											class="h-[var(--app-button-height-small)] rounded-[var(--app-radius-control)] border border-transparent bg-transparent px-1 text-xs text-[color:var(--app-text-secondary)] hover:bg-[color:var(--app-hover)]"
											aria-label={`Role of ${p?.name ?? m.userId}`}
											title={lastOwner ? 'A teamspace needs at least one owner' : undefined}
											disabled={lastOwner}
											value={m.role}
											onchange={(e) => run(() => store.setTeamspaceMemberRole(ts.id, m.userId, e.currentTarget.value as 'owner' | 'member'))}
										>
											<option value="owner">Owner</option>
											<option value="member">Member</option>
										</select>
										<Button
											variant="ghost"
											size="small"
											color="danger"
											disabled={lastOwner}
											onclick={() => (self ? leave() : run(() => store.removeTeamspaceMember(ts.id, m.userId)))}
										>
											{self ? 'Leave' : 'Remove'}
										</Button>
									{:else}
										<OptionTag color={m.role === 'owner' ? 'purple' : 'gray'} label={m.role === 'owner' ? 'Owner' : 'Member'} />
										{#if self}
											<Button variant="ghost" size="small" color="danger" onclick={leave}>Leave</Button>
										{/if}
									{/if}
								</li>
							{/each}
						</ul>
						{#if mineLast && !canManage}
							<p class="mt-1 text-xs text-[color:var(--app-text-tertiary)]">You are the only owner.</p>
						{/if}
					{/if}
					{#if error}<p class="mt-2 text-sm text-[color:var(--app-danger)]" role="alert">{error}</p>{/if}
				</section>

				{#if canManage}
					<section class="flex items-center justify-between gap-3 border-t border-[color:var(--app-hairline)] pt-3" aria-label="Danger zone">
						<span class="flex flex-col text-sm">
							<span class="font-medium">Archive teamspace</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">Archives the teamspace and all its pages. An owner can restore it from Settings within 30 days.</span>
						</span>
						<Button variant="outline" color="danger" size="small" onclick={() => (confirmOpen = true)} data-testid="teamspace-archive">Archive</Button>
					</section>
				{/if}
			</div>
		{/if}
	{/snippet}
</Dialog>

<Dialog bind:open={confirmOpen} type="alert" size="small">
	{#snippet title()}Archive {ts?.name ?? 'this teamspace'}?{/snippet}
	{#snippet description()}The teamspace and every page in it are archived. Members lose access to them until an owner restores the teamspace from Settings, and everything is deleted for good after 30 days.{/snippet}
	{#snippet footer()}
		<div class="flex justify-end gap-2 pt-2 pb-1">
			<Button variant="ghost" onclick={() => (confirmOpen = false)}>Cancel</Button>
			<Button color="danger" loading={busy} onclick={archive} data-testid="teamspace-archive-confirm">Archive teamspace</Button>
		</div>
	{/snippet}
</Dialog>
