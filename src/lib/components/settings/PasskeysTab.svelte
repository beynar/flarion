<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { isMock } from '#lib/client/runtime.ts';
	import { authClient } from '#lib/client/auth.ts';

	interface PasskeyInfo {
		id: string;
		name?: string | null;
		deviceType?: string | null;
		backedUp?: boolean | null;
		createdAt?: string | Date | null;
	}

	let passkeys = $state<PasskeyInfo[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let unavailable = $state(false);

	const MOCK_KEYS: PasskeyInfo[] = [
		{ id: 'pk_1', name: 'MacBook Touch ID', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-10-03T09:00:00Z' },
		{ id: 'pk_2', name: 'YubiKey 5C', deviceType: 'singleDevice', backedUp: false, createdAt: '2026-10-19T09:00:00Z' }
	];

	async function load() {
		loading = true;
		if (isMock()) {
			passkeys = MOCK_KEYS;
			loading = false;
			return;
		}
		try {
			const { data, error } = await authClient.passkey.listUserPasskeys();
			if (error) toast.danger({ title: 'Could not load passkeys', description: error.message });
			passkeys = (data ?? []) as PasskeyInfo[];
		} catch {
			unavailable = true;
		}
		loading = false;
	}
	onMount(load);

	async function add() {
		busy = true;
		try {
			if (isMock()) {
				passkeys = [...passkeys, { id: `pk_${passkeys.length + 1}`, name: 'New passkey', deviceType: 'multiDevice', backedUp: true, createdAt: new Date().toISOString() }];
			} else {
				const { error } = await authClient.passkey.addPasskey({ name: `Passkey ${passkeys.length + 1}` });
				if (error) throw new Error(error.message ?? 'Request failed');
				await load();
			}
		} catch (e) {
			toast.danger({ title: 'Could not add the passkey', description: (e as Error).message });
		} finally {
			busy = false;
		}
	}

	// Renaming one passkey at a time: its id and the draft name.
	let editing = $state<string | null>(null);
	let draft = $state<string | null>('');
	let saving = $state(false);

	function startRename(key: PasskeyInfo) {
		editing = key.id;
		draft = key.name || '';
	}

	async function saveRename(event: SubmitEvent) {
		event.preventDefault();
		const id = editing;
		const name = draft?.trim();
		if (!id || !name) return;
		saving = true;
		try {
			if (!isMock()) {
				const { error } = await authClient.passkey.updatePasskey({ id, name });
				if (error) throw new Error(error.message ?? 'Request failed');
			}
			passkeys = passkeys.map((p) => (p.id === id ? { ...p, name } : p));
			editing = null;
		} catch (e) {
			toast.danger({ title: 'Could not rename the passkey', description: (e as Error).message });
		} finally {
			saving = false;
		}
	}

	async function remove(id: string) {
		try {
			if (!isMock()) {
				const { error } = await authClient.passkey.deletePasskey({ id });
				if (error) throw new Error(error.message ?? 'Request failed');
			}
			passkeys = passkeys.filter((p) => p.id !== id);
		} catch (e) {
			toast.danger({ title: 'Could not remove the passkey', description: (e as Error).message });
		}
	}

	const when = (v?: string | Date | null) => (v ? new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
</script>

<section aria-labelledby="passkeys-h" data-testid="passkeys-tab">
	<div class="mb-4 flex items-center gap-3">
		<div class="flex-1">
			<h2 id="passkeys-h" class="mb-1 text-base font-semibold">Passkeys</h2>
			<p class="m-0 text-sm text-[color:var(--app-text-secondary)]">Passkeys are how you sign in: no password to remember or leak.</p>
		</div>
		<Button prefix={fingerprintIcon} loading={busy} disabled={unavailable} onclick={add}>Add a passkey</Button>
	</div>

	{#if unavailable}
		<p class="text-sm text-[color:var(--app-text-secondary)]">Passkey management is not available in this build.</p>
	{:else if loading}
		<div class="h-9 animate-pulse rounded bg-[color:var(--app-hover)]" aria-busy="true"></div>
	{:else}
		<ul class="m-0 flex list-none flex-col border-t border-[color:var(--app-hairline)] p-0">
			{#each passkeys as key (key.id)}
				<li class="flex items-center gap-3 border-b border-[color:var(--app-hairline)] text-sm" style="min-height: var(--app-table-row-height)">
					<span class="text-[color:var(--app-text-tertiary)]">{@render fingerprintIcon({ size: 16 })}</span>
					{#if editing === key.id}
						<form class="flex min-w-0 flex-1 items-center gap-2 py-1" onsubmit={saveRename}>
							<div class="min-w-0 flex-1">
								<TextInput placeholder="Passkey name" bind:value={draft} inputAttrs={{ 'aria-label': 'Passkey name' }} />
							</div>
							<Button type="submit" size="small" loading={saving} disabled={!draft?.trim()}>Save</Button>
							<Button type="button" variant="ghost" size="small" onclick={() => (editing = null)}>Cancel</Button>
						</form>
					{:else}
						<span class="min-w-0 flex-1 truncate" data-testid="passkey-name">{key.name || 'Passkey'}</span>
						<span class="hidden text-xs text-[color:var(--app-text-tertiary)] md:inline">
							{key.backedUp ? 'Synced' : 'This device only'}{key.createdAt ? ` · added ${when(key.createdAt)}` : ''}
						</span>
						<Button variant="ghost" size="small" onclick={() => startRename(key)}>Rename</Button>
						<Button
							variant="ghost"
							size="small"
							color="danger"
							disabled={passkeys.length < 2}
							label={passkeys.length < 2 ? 'Your last passkey cannot be removed' : `Remove ${key.name || 'passkey'}`}
							onclick={() => remove(key.id)}>Remove</Button
						>
					{/if}
				</li>
			{:else}
				<li class="py-3 text-sm text-[color:var(--app-text-tertiary)]">No passkeys yet.</li>
			{/each}
		</ul>
	{/if}
</section>
