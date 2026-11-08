<script lang="ts">
	import { Button } from 'entasis/button';
	import { confirmation } from 'entasis/confirmation';
	import { Select } from 'entasis/select';
	import { toast } from 'entasis/toast';
	import { rpc } from '#lib/client/rpc.ts';
	import { useWorkspace } from '#lib/client/workspace.svelte.ts';
	import DeleteAccount from './DeleteAccount.svelte';

	const store = useWorkspace();

	const isOwner = $derived(store.workspace.role === 'owner');
	const heirs = $derived(store.members.filter((m) => m.userId !== store.user.id && m.role !== 'guest').map((m) => ({ value: m.userId, label: m.name, description: m.email })));
	let heir = $state<string | null>(null);

	const fail = (title: string, e: unknown) => toast.danger({ title, description: (e as Error).message });

	async function transfer() {
		const target = heirs.find((h) => h.value === heir);
		if (!target) return;
		const outcome = await confirmation({
			title: `Make ${target.label} the owner of ${store.workspace.name}?`,
			description: 'They take over the workspace and its deletion. You stay as an admin, and only they can hand it back.',
			confirm: { text: 'Transfer ownership', color: 'danger', 'data-testid': 'transfer-confirm' },
			cancel: 'Cancel',
			onConfirm: () =>
				rpc.workspace.transferOwnership({ userId: target.value }).then(
					() => true,
					(e) => (fail('Could not transfer ownership', e), false)
				)
		});
		if (outcome.confirmed && outcome.result) {
			toast.success({ title: 'Ownership transferred', description: `${target.label} owns ${store.workspace.name} now.` });
			// The role everywhere in the app (settings, the sidebar) is read at load: start over.
			window.location.reload();
		}
	}
</script>

<section aria-labelledby="account-h" data-testid="account-tab">
	<h2 id="account-h" class="mb-4 text-base font-semibold">Account</h2>

	{#if isOwner}
		<div class="mb-8" data-testid="transfer-ownership">
			<h3 class="mb-1 text-sm font-semibold">Transfer ownership</h3>
			<p class="mb-3 text-sm text-[color:var(--app-text-secondary)]">
				You own {store.workspace.name}. Hand it to another member before you delete your account, or delete the workspace in its settings.
			</p>
			<div class="flex flex-wrap items-end gap-2">
				<div class="min-w-[240px] flex-1">
					<Select label="New owner" items={heirs} value={heir} onValueChange={(next) => (heir = next)} placeholder="Choose a member" alignItemWithTrigger={false} />
				</div>
				<Button variant="outline" disabled={!heir} onclick={transfer} data-testid="transfer-button">Transfer</Button>
			</div>
		</div>
	{/if}

	<DeleteAccount />
</section>
