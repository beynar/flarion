<script lang="ts">
	import { onMount } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Chip } from 'entasis/chip';
	import { confirmation } from 'entasis/confirmation';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Dialog } from 'entasis/dialog';
	import { Empty } from 'entasis/empty';
	import { Select } from 'entasis/select';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { copyIcon } from 'entasis/icons/copy';
	import { plusIcon } from 'entasis/icons/plus';
	import { rpc } from '#lib/client/rpc.ts';
	import { TOKEN_SCOPES, type ApiToken, type TokenScope } from '#lib/shared/schemas.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';

	/** What each scope lets a token do, in the words of the settings screen. */
	const SCOPE_LABELS: Record<TokenScope, { label: string; hint: string }> = {
		'page.read': { label: 'Read pages', hint: 'Retrieve pages and their properties' },
		'page.create': { label: 'Create pages', hint: 'Add pages and database rows' },
		'page.update': { label: 'Edit pages', hint: 'Change properties, icon and cover' },
		'page.trash': { label: 'Trash and restore pages', hint: 'Move pages to the trash and back' },
		'block.read': { label: 'Read content', hint: 'List the blocks of a page' },
		'block.write': { label: 'Write content', hint: 'Append blocks to a page' },
		'database.read': { label: 'Read databases', hint: 'Retrieve and query databases' },
		search: { label: 'Search', hint: 'Search pages and databases' },
		'comment.read': { label: 'Read comments', hint: 'List comments on pages' },
		'comment.write': { label: 'Write comments', hint: 'Comment on pages and reply' },
		'user.read': { label: 'Read members', hint: 'List and retrieve workspace members' }
	};
	const SCOPE_ITEMS = TOKEN_SCOPES.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope].label, description: SCOPE_LABELS[scope].hint }));
	const EXPIRY_ITEMS = [
		{ value: 'never', label: 'Never expires' },
		{ value: '30', label: 'In 30 days' },
		{ value: '90', label: 'In 90 days' },
		{ value: '365', label: 'In a year' }
	];

	let tokens = $state<ApiToken[]>([]);
	let loading = $state(true);
	let error = $state('');

	let creating = $state(false);
	let name = $state('');
	let scopes = $state<string[]>([]);
	let expiry = $state('never');
	let busy = $state(false);
	/** The secret of the token just made: shown once, then gone. */
	let secret = $state<{ token: string; name: string } | null>(null);
	let secretOpen = $state(false);

	const fail = (title: string, e: unknown) => toast.danger({ title, description: (e as Error).message });
	const now = () => Date.now();
	const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null);

	type Status = 'active' | 'revoked' | 'expired';
	const statusOf = (t: ApiToken): Status => (t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= now() ? 'expired' : 'active');

	async function load() {
		loading = true;
		error = '';
		try {
			tokens = await rpc.tokens.list();
		} catch (e) {
			error = (e as Error).message || 'Could not load your tokens';
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openCreate() {
		name = '';
		scopes = ['page.read', 'block.read', 'database.read', 'search'];
		expiry = 'never';
		creating = true;
	}

	async function create(event?: Event) {
		event?.preventDefault();
		if (!name.trim() || busy) return;
		busy = true;
		try {
			const expiresAt = expiry === 'never' ? null : new Date(now() + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
			const result = await rpc.tokens.create({ name: name.trim(), scopes: scopes as TokenScope[], expiresAt });
			tokens = [result.info, ...tokens];
			creating = false;
			secret = { token: result.token, name: result.info.name };
			secretOpen = true;
		} catch (e) {
			fail('Could not create the token', e);
		} finally {
			busy = false;
		}
	}

	async function copySecret() {
		if (!secret) return;
		try {
			await navigator.clipboard.writeText(secret.token);
			toast.success({ title: 'Token copied' });
		} catch {
			toast.info({ title: 'Copy the token by hand', description: 'Select it and press Ctrl+C.' });
		}
	}

	function closeSecret() {
		secretOpen = false;
		secret = null;
	}

	async function revoke(token: ApiToken) {
		const outcome = await confirmation({
			title: `Revoke "${token.name}"?`,
			description: 'Anything using this token stops working at once. This cannot be undone: make a new token instead.',
			confirm: { text: 'Revoke token', color: 'danger', 'data-testid': 'token-revoke-confirm' },
			cancel: 'Cancel',
			onConfirm: () =>
				rpc.tokens.revoke({ id: token.id }).then(
					() => true,
					(e) => (fail('Could not revoke the token', e), false)
				)
		});
		if (outcome.confirmed && outcome.result) await load();
	}

	const columns: DataTableColumn<ApiToken>[] = [
		{ id: 'name', accessor: 'name', header: 'Name', cell: nameCell },
		{ id: 'scopes', accessor: (t) => t.scopes.length, header: 'Access', cell: scopesCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'used', accessor: (t) => t.lastUsedAt ?? '', header: 'Last used', cell: usedCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'status', accessor: (t) => statusOf(t), header: 'Status', cell: statusCell },
		{ id: 'actions', accessor: 'id', header: '', cell: revokeCell, align: 'end' }
	];
	const theme = listTheme({
		columns:
			'max-md:grid-cols-[minmax(0,1fr)_96px_88px]! md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_120px_96px_88px]!'
	});
</script>

{#snippet nameCell(p: { row: ApiToken })}
	<span class="flex min-w-0 flex-col">
		<span class="truncate" data-testid="token-name">{p.row.name}</span>
		<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">
			Created {dateOf(p.row.createdAt)}{p.row.expiresAt ? ` · expires ${dateOf(p.row.expiresAt)}` : ''}
		</span>
	</span>
{/snippet}

{#snippet scopesCell(p: { row: ApiToken })}
	<span class="truncate text-xs text-[color:var(--app-text-secondary)]" title={p.row.scopes.join(', ')}>
		{p.row.scopes.length === 0 ? 'No access' : p.row.scopes.length === TOKEN_SCOPES.length ? 'Everything' : `${p.row.scopes.length} of ${TOKEN_SCOPES.length} scopes`}
	</span>
{/snippet}

{#snippet usedCell(p: { row: ApiToken })}
	<span class="truncate text-xs text-[color:var(--app-text-tertiary)]">{dateOf(p.row.lastUsedAt) ?? 'Never'}</span>
{/snippet}

{#snippet statusCell(p: { row: ApiToken })}
	{@const status = statusOf(p.row)}
	<Chip size="small" variant="soft" color={status === 'active' ? 'success' : status === 'expired' ? 'warning' : 'neutral'}>
		{status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Revoked'}
	</Chip>
{/snippet}

{#snippet revokeCell(p: { row: ApiToken })}
	{#if statusOf(p.row) !== 'revoked'}
		<Button variant="ghost" size="small" color="danger" label={`Revoke ${p.row.name}`} onclick={() => revoke(p.row)}>Revoke</Button>
	{/if}
{/snippet}

{#snippet none()}
	<Empty size="small" title="No tokens yet." description="Make one to call the API from a script or an integration." />
{/snippet}

<section aria-labelledby="tokens-h" data-testid="tokens-tab">
	<div class="mb-4 flex items-center gap-3">
		<div class="flex-1">
			<h2 id="tokens-h" class="mb-1 text-base font-semibold">API tokens</h2>
			<p class="m-0 text-sm text-[color:var(--app-text-secondary)]">
				A token acts as you in this workspace, with only the access you give it. Read the
				<a class="underline" href="/v1/docs" target="_blank" rel="noreferrer">API reference</a>.
			</p>
		</div>
		<Button prefix={plusIcon} onclick={openCreate} data-testid="token-create">New token</Button>
	</div>

	{#if error}
		<Alert color="danger" variant="soft" size="small">{error}</Alert>
	{:else}
		<DataTable items={tokens} {columns} getRowId={(t) => t.id} density="compact" pagination={false} {loading} empty={none} caption="API tokens" {theme} />
	{/if}
</section>

<Dialog bind:open={creating} size="small" closable>
	{#snippet title()}New API token{/snippet}
	{#snippet description()}Choose what it may do. You can revoke it at any time, but not change it.{/snippet}
	{#snippet children()}
		<form class="flex flex-col gap-4 pt-1 pb-2" onsubmit={create} data-testid="token-form">
			<TextInput label="Name" placeholder="Deploy bot, nightly export" bind:value={name} inputAttrs={{ maxlength: 100, 'data-testid': 'token-name-input' }} />
			<Select
				label="Access"
				multiple
				items={SCOPE_ITEMS}
				value={scopes}
				onValueChange={(next) => (scopes = next ?? [])}
				placeholder="No access"
				alignItemWithTrigger={false}
				triggerAttrs={{ 'data-testid': 'token-scopes' }}
			/>
			<Select label="Expires" items={EXPIRY_ITEMS} value={expiry} onValueChange={(next) => next && (expiry = next)} alignItemWithTrigger={false} />
			{#if scopes.length === 0}
				<Alert color="warning" variant="soft" size="small">A token without any access can call nothing. Pick at least one.</Alert>
			{/if}
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				<Button type="submit" loading={busy} disabled={!name.trim() || scopes.length === 0} data-testid="token-submit">Create token</Button>
			</div>
		</form>
	{/snippet}
</Dialog>

<Dialog open={secretOpen} onOpenChange={(next) => !next && closeSecret()} size="small" closable>
	{#snippet title()}Your new token{/snippet}
	{#snippet description()}Copy it now: it is shown only once and cannot be recovered.{/snippet}
	{#snippet children()}
		{#if secret}
			<div class="flex flex-col gap-4 pt-1 pb-2" data-testid="token-secret-dialog">
				<TextInput label={secret.name} value={secret.token} readOnly inputAttrs={{ 'data-testid': 'token-secret', spellcheck: false, autocomplete: 'off' }} />
				<Alert color="warning" variant="soft" size="small">Treat it like a password. Anyone with this token can act as you with the access you chose.</Alert>
				<div class="flex justify-end gap-2">
					<Button variant="outline" prefix={copyIcon} onclick={copySecret} data-testid="token-copy">Copy token</Button>
					<Button onclick={closeSecret} data-testid="token-done">Done</Button>
				</div>
			</div>
		{/if}
	{/snippet}
</Dialog>
