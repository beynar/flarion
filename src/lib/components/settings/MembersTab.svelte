<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Select } from 'entasis/select';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { rpc } from '#lib/client/rpc.ts';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import type { Invite, Member } from '#lib/shared/schemas.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';

	let { initial = null }: { initial?: { invites: Invite[] } | null } = $props();

	const store = useWorkspace();
	const ROLES = ['admin', 'member', 'guest'] as const;
	type Role = (typeof ROLES)[number];

	// The server render read the people and the pending invitations: on screen from the first paint, and not asked for again.
	let members = $state<Member[]>(untrack(() => (initial ? store.members : [])));
	let invites = $state<Invite[]>(untrack(() => (initial ? initial.invites.filter((x) => !x.acceptedAt) : [])));
	let loading = $state(untrack(() => !initial));
	let error = $state('');
	let email = $state('');
	let role = $state<Role>('member');
	let sending = $state(false);

	const canManage = $derived(store.workspace.role === 'owner' || store.workspace.role === 'admin');
	const roleColor = (r: string) => (r === 'owner' ? 'primary' : r === 'admin' ? 'info' : r === 'guest' ? 'warning' : 'neutral');
	const capitalize = (r: string) => r[0].toUpperCase() + r.slice(1);
	const ROLE_ITEMS = ROLES.map((r) => ({ value: r, label: capitalize(r) }));
	const fail = (title: string, e: unknown) => toast.danger({ title, description: (e as Error).message });

	async function load() {
		loading = true;
		error = '';
		try {
			const [m, i] = await Promise.all([rpc.workspace.members.list(), canManage ? rpc.workspace.invites.list() : Promise.resolve([] as Invite[])]);
			members = m;
			invites = i.filter((x) => !x.acceptedAt);
		} catch (e) {
			error = (e as Error).message || 'Could not load members';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (!initial) void load();
	});

	async function invite(event?: SubmitEvent) {
		event?.preventDefault();
		if (!email.trim()) return;
		sending = true;
		try {
			const created = await rpc.workspace.invites.create({ email: email.trim(), role });
			invites = [created, ...invites];
			toast.success({ title: 'Invitation sent', description: created.email });
			email = '';
		} catch (e) {
			fail('Could not send the invitation', e);
		} finally {
			sending = false;
		}
	}

	async function revoke(id: string) {
		try {
			await rpc.workspace.invites.revoke({ id });
			invites = invites.filter((i) => i.id !== id);
		} catch (e) {
			fail('Could not revoke the invitation', e);
		}
	}

	async function setRole(member: Member, next: Role) {
		const prev = member.role;
		members = members.map((m) => (m.userId === member.userId ? { ...m, role: next } : m));
		try {
			await rpc.workspace.members.setRole({ userId: member.userId, role: next });
		} catch (e) {
			members = members.map((m) => (m.userId === member.userId ? { ...m, role: prev } : m));
			fail('Could not change the role', e);
		}
	}

	async function remove(member: Member) {
		try {
			await rpc.workspace.members.remove({ userId: member.userId });
			members = members.filter((m) => m.userId !== member.userId);
		} catch (e) {
			fail('Could not remove the member', e);
		}
	}

	const memberColumns: DataTableColumn<Member>[] = [
		{ id: 'member', accessor: 'name', header: 'Name', cell: memberCell },
		{ id: 'email', accessor: 'email', header: 'Email', cell: emailCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'role', accessor: 'role', header: 'Role', cell: roleCell },
		{ id: 'actions', accessor: 'userId', header: '', cell: removeCell, align: 'end' }
	];
	const inviteColumns: DataTableColumn<Invite>[] = [
		{ id: 'email', accessor: 'email', header: 'Pending invitations', cell: inviteEmail },
		{ id: 'role', accessor: 'role', header: 'Role', cell: inviteRole },
		{ id: 'expires', accessor: 'expiresAt', header: 'Expires', cell: inviteExpires, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'actions', accessor: 'id', header: '', cell: revokeCell, align: 'end' }
	];
	const memberTheme = listTheme({
		columns: 'max-md:grid-cols-[minmax(0,1fr)_136px_96px]! md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_136px_96px]!'
	});
	const inviteTheme = listTheme({
		columns: 'max-md:grid-cols-[minmax(0,1fr)_96px_72px]! md:grid-cols-[minmax(0,1fr)_96px_120px_72px]!'
	});
</script>

{#snippet memberCell(p: { row: Member })}
	<span class="flex min-w-0 items-center gap-3">
		<Avatar size="small" name={p.row.name} />
		<span class="truncate">{p.row.name}{p.row.userId === store.user.id ? ' (you)' : ''}</span>
	</span>
{/snippet}

{#snippet emailCell(p: { row: Member })}
	<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{p.row.email}</span>
{/snippet}

{#snippet roleCell(p: { row: Member })}
	{#if canManage && p.row.role !== 'owner' && p.row.userId !== store.user.id}
		<div class="w-full">
			<Select
				size="small"
				items={ROLE_ITEMS}
				value={p.row.role}
				alignItemWithTrigger={false}
				onValueChange={(next) => next && next !== p.row.role && setRole(p.row, next as Role)}
				triggerAttrs={{ 'aria-label': `Role of ${p.row.name}` }}
			/>
		</div>
	{:else}
		<Chip size="small" variant="soft" color={roleColor(p.row.role)}>{capitalize(p.row.role)}</Chip>
	{/if}
{/snippet}

{#snippet removeCell(p: { row: Member })}
	{#if canManage && p.row.role !== 'owner' && p.row.userId !== store.user.id}
		<Button variant="ghost" size="small" color="danger" onclick={() => remove(p.row)}>Remove</Button>
	{/if}
{/snippet}

{#snippet inviteEmail(p: { row: Invite })}
	<span class="truncate">{p.row.email}</span>
{/snippet}

{#snippet inviteRole(p: { row: Invite })}
	<Chip size="small" variant="soft" color={roleColor(p.row.role)}>{capitalize(p.row.role)}</Chip>
{/snippet}

{#snippet inviteExpires(p: { row: Invite })}
	<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">Expires {new Date(p.row.expiresAt).toLocaleDateString()}</span>
{/snippet}

{#snippet revokeCell(p: { row: Invite })}
	{#if canManage}<Button variant="ghost" size="small" onclick={() => revoke(p.row.id)}>Revoke</Button>{/if}
{/snippet}

<section aria-labelledby="members-h" data-testid="members-tab">
	<h2 id="members-h" class="mb-1 text-base font-semibold">Members</h2>
	<p class="mb-4 text-sm text-[color:var(--app-text-secondary)]">People in {store.workspace.name} and the invitations still waiting.</p>

	{#if canManage}
		<form class="mb-6 flex flex-wrap items-end gap-2" onsubmit={invite} data-testid="invite-form">
			<div class="min-w-[220px] flex-1">
				<TextInput label="Invite by email" type="email" placeholder="teammate@company.com" bind:value={email} />
			</div>
			<div class="w-32">
				<Select label="Role" items={ROLE_ITEMS} value={role} onValueChange={(v) => v && (role = v as Role)} alignItemWithTrigger={false} />
			</div>
			<Button type="submit" loading={sending} disabled={!email.trim()}>Send invite</Button>
		</form>
	{/if}

	{#if error}
		<Alert color="danger" variant="soft" size="small">{error}</Alert>
	{:else}
		<DataTable
			items={members}
			columns={memberColumns}
			getRowId={(m) => m.userId}
			density="compact"
			pagination={false}
			{loading}
			caption="Members"
			theme={memberTheme}
		/>

		{#if invites.length}
			<div class="mt-8" data-testid="pending-invites">
				<DataTable
					items={invites}
					columns={inviteColumns}
					getRowId={(i) => i.id}
					density="compact"
					pagination={false}
					caption="Pending invitations"
					theme={inviteTheme}
				/>
			</div>
		{/if}
	{/if}
</section>
