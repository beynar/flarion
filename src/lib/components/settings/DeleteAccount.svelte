<script lang="ts">
	import { onMount } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { ORPCError } from '@orpc/client';
	import { rpc } from '#lib/client/rpc.ts';

	/** Deleting the signed-in account: needs no workspace, so it also lives at /account for someone who has none left. */
	let email = $state('');
	let owned = $state<{ id: string; name: string }[]>([]);
	let loaded = $state(false);
	let deleting = $state(false);
	let confirmEmail = $state('');
	let busy = $state(false);

	const fail = (title: string, e: unknown) => toast.danger({ title, description: (e as Error).message });

	async function load() {
		try {
			const [me, mine] = await Promise.all([rpc.me(), rpc.account.owned()]);
			email = me.email;
			owned = mine;
		} catch (e) {
			fail('Could not load your account', e);
		} finally {
			loaded = true;
		}
	}
	onMount(load);

	async function deleteAccount(event?: Event) {
		event?.preventDefault();
		if (busy) return;
		busy = true;
		try {
			await rpc.account.delete({ confirmEmail: confirmEmail.trim() });
			window.location.assign('/login');
		} catch (e) {
			if (e instanceof ORPCError && e.code === 'CONFLICT') {
				const data = e.data as { workspaces?: { id: string; name: string }[] } | undefined;
				owned = data?.workspaces ?? owned;
				deleting = false;
			}
			fail('Could not delete your account', e);
		} finally {
			busy = false;
		}
	}
</script>

<div data-testid="delete-account">
	<h3 class="mb-1 text-sm font-semibold">Delete your account</h3>
	<p class="mb-1 text-sm text-[color:var(--app-text-secondary)]">{email}</p>
	<p class="mb-3 text-sm text-[color:var(--app-text-secondary)]">
		This removes you from every workspace, deletes your passkeys and revokes your API tokens. What you wrote stays, shown as "Deleted user".
	</p>
	{#if loaded && owned.length > 0}
		<Alert color="warning" variant="soft" size="small" class="mb-3">
			You own {owned.map((w) => `"${w.name}"`).join(', ')}. Transfer ownership or delete {owned.length === 1 ? 'it' : 'them'} first.
		</Alert>
	{/if}
	<Button color="danger" variant="outline" disabled={!loaded || owned.length > 0} onclick={() => ((confirmEmail = ''), (deleting = true))} data-testid="delete-account-button">Delete account</Button>
</div>

<Dialog bind:open={deleting} size="small" closable>
	{#snippet title()}Delete your account?{/snippet}
	{#snippet description()}This cannot be undone. Type your email, {email}, to confirm.{/snippet}
	{#snippet children()}
		<form class="flex flex-col gap-4 pt-1 pb-2" onsubmit={deleteAccount} data-testid="delete-account-form">
			<TextInput label="Your email" type="email" bind:value={confirmEmail} inputAttrs={{ autocomplete: 'off', 'data-testid': 'delete-account-email' }} />
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (deleting = false)}>Cancel</Button>
				<Button type="submit" color="danger" loading={busy} disabled={confirmEmail.trim().toLowerCase() !== email.toLowerCase()} data-testid="delete-account-confirm">Delete my account</Button>
			</div>
		</form>
	{/snippet}
</Dialog>
