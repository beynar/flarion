<script lang="ts">
	import { onMount } from 'svelte';
	import { Avatar } from 'entasis/avatar';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { rpc } from '#lib/client/rpc.ts';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import type { Invite, Member } from '#lib/shared/schemas.ts';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';

	const store = useWorkspace();
	const ROLES = ['admin', 'member', 'guest'] as const;
	type Role = (typeof ROLES)[number];

	let members = $state<Member[]>([]);
	let invites = $state<Invite[]>([]);
	let loading = $state(true);
	let error = $state('');
	let email = $state('');
	let role = $state<Role>('member');
	let sending = $state(false);

	const canManage = $derived(store.workspace.role === 'owner' || store.workspace.role === 'admin');
	const roleColor = (r: string) => (r === 'owner' ? 'purple' : r === 'admin' ? 'blue' : r === 'guest' ? 'orange' : 'gray');
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
	onMount(load);

	async function invite(event: SubmitEvent) {
		event.preventDefault();
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
</script>

<section aria-labelledby="members-h" data-testid="members-tab">
	<h2 id="members-h" class="mb-1 text-base font-semibold">Members</h2>
	<p class="mb-4 text-sm text-[color:var(--app-text-secondary)]">People in {store.workspace.name} and the invitations still waiting.</p>

	{#if canManage}
		<form class="mb-6 flex flex-wrap items-end gap-2" onsubmit={invite} data-testid="invite-form">
			<div class="min-w-[220px] flex-1">
				<TextInput label="Invite by email" type="email" placeholder="teammate@company.com" bind:value={email} />
			</div>
			<label class="flex flex-col gap-1 text-sm text-[color:var(--app-text-secondary)]">
				<span class="font-medium text-[color:var(--app-text)]">Role</span>
				<select
					class="rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm text-[color:var(--app-text)]"
					style="height: var(--app-input-height)"
					bind:value={role}
				>
					{#each ROLES as r (r)}<option value={r}>{r[0].toUpperCase() + r.slice(1)}</option>{/each}
				</select>
			</label>
			<Button type="submit" loading={sending} disabled={!email.trim()}>Send invite</Button>
		</form>
	{/if}

	{#if error}
		<p class="text-sm text-[color:var(--app-danger)]">{error}</p>
	{:else if loading}
		<div class="flex flex-col gap-2" aria-busy="true">
			{#each [1, 2, 3] as i (i)}<div class="h-9 animate-pulse rounded bg-[color:var(--app-hover)]"></div>{/each}
		</div>
	{:else}
		<ul class="m-0 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0">
			{#each members as member (member.userId)}
				<li class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm" style="min-height: var(--app-table-row-height)">
					<Avatar size="small" name={member.name} />
					<span class="min-w-0 flex-1 truncate">{member.name}{member.userId === store.user.id ? ' (you)' : ''}</span>
					<span class="hidden truncate text-xs text-[color:var(--app-text-tertiary)] md:inline">{member.email}</span>
					{#if canManage && member.role !== 'owner' && member.userId !== store.user.id}
						<select
							class="rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline)] bg-transparent px-1 text-xs"
							style="height: var(--app-button-height-small)"
							aria-label={`Role of ${member.name}`}
							value={member.role}
							onchange={(e) => setRole(member, e.currentTarget.value as Role)}
						>
							{#each ROLES as r (r)}<option value={r}>{r[0].toUpperCase() + r.slice(1)}</option>{/each}
						</select>
						<Button variant="ghost" size="small" color="danger" onclick={() => remove(member)}>Remove</Button>
					{:else}
						<OptionTag color={roleColor(member.role)} label={member.role[0].toUpperCase() + member.role.slice(1)} />
					{/if}
				</li>
			{/each}
		</ul>

		{#if invites.length}
			<h3 class="mt-8 mb-2 text-xs font-medium text-[color:var(--app-text-tertiary)]">Pending invitations</h3>
			<ul class="m-0 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0" data-testid="pending-invites">
				{#each invites as inv (inv.id)}
					<li class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm" style="min-height: var(--app-table-row-height)">
						<span class="min-w-0 flex-1 truncate">{inv.email}</span>
						<OptionTag color={roleColor(inv.role)} label={inv.role[0].toUpperCase() + inv.role.slice(1)} />
						<span class="hidden text-xs text-[color:var(--app-text-tertiary)] md:inline">Expires {new Date(inv.expiresAt).toLocaleDateString()}</span>
						{#if canManage}<Button variant="ghost" size="small" onclick={() => revoke(inv.id)}>Revoke</Button>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>
