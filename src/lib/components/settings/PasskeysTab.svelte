<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Empty } from 'entasis/empty';
	import { toast } from 'entasis/toast';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { pencilIcon } from 'entasis/icons/pencil';
	import { isMock } from '#lib/client/runtime.ts';
	import { authClient } from '#lib/client/auth.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';

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

	/** The table's text editor commits here (Enter or blur); a rejection keeps the editor open on its error. */
	async function rename({ rowId, value }: { rowId: string; value: unknown }) {
		const name = String(value ?? '').trim();
		if (!name) throw new Error('A passkey needs a name');
		try {
			if (!isMock()) {
				const { error } = await authClient.passkey.updatePasskey({ id: rowId, name });
				if (error) throw new Error(error.message ?? 'Request failed');
			}
			passkeys = passkeys.map((p) => (p.id === rowId ? { ...p, name } : p));
		} catch (e) {
			throw new Error(`Could not rename the passkey: ${(e as Error).message}`);
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

	const columns: DataTableColumn<PasskeyInfo>[] = [
		{ id: 'name', accessor: (k) => k.name || 'Passkey', header: 'Name', cell: nameCell, editor: { type: 'text', placeholder: 'Passkey name' } },
		{ id: 'details', accessor: (k) => when(k.createdAt), header: 'Added', cell: detailsCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'actions', accessor: 'id', header: '', cell: removeCell, align: 'end' }
	];
	const theme = listTheme({ columns: 'max-md:grid-cols-[minmax(0,1fr)_96px]! md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px]!' });
</script>

{#snippet nameCell(p: { row: PasskeyInfo; startEditing: () => void })}
	<span class="flex min-w-0 items-center gap-2">
		<span class="text-[color:var(--app-text-tertiary)]">{@render fingerprintIcon({ size: 16 })}</span>
		<span class="truncate" data-testid="passkey-name">{p.row.name || 'Passkey'}</span>
		<!-- stopPropagation: the editor commits on any document click, and this click is still travelling up when it opens (entasis DataTable). -->
		<Button
			variant="ghost"
			size="small"
			prefix={pencilIcon}
			label="Rename"
			onclick={(event) => {
				event.stopPropagation();
				p.startEditing();
			}}
		/>
	</span>
{/snippet}

{#snippet detailsCell(p: { row: PasskeyInfo })}
	<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">
		{p.row.backedUp ? 'Synced' : 'This device only'}{p.row.createdAt ? ` · added ${when(p.row.createdAt)}` : ''}
	</span>
{/snippet}

{#snippet removeCell(p: { row: PasskeyInfo })}
	<Button
		variant="ghost"
		size="small"
		color="danger"
		disabled={passkeys.length < 2}
		label={passkeys.length < 2 ? 'Your last passkey cannot be removed' : `Remove ${p.row.name || 'passkey'}`}
		onclick={() => remove(p.row.id)}>Remove</Button
	>
{/snippet}

{#snippet none()}
	<Empty size="small" title="No passkeys yet." />
{/snippet}

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
	{:else}
		<DataTable
			items={passkeys}
			{columns}
			getRowId={(k) => k.id}
			density="compact"
			pagination={false}
			{loading}
			empty={none}
			caption="Passkeys"
			{theme}
			onCellCommit={rename}
		/>
	{/if}
</section>
