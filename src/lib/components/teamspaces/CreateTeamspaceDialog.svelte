<script lang="ts">
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Teamspace } from '#lib/shared/schemas.ts';
	import IconPicker from '#lib/components/pickers/IconPicker.svelte';
	import LevelSelect from '#lib/components/share/LevelSelect.svelte';
	import { PRIVACY_OPTIONS } from './levels.ts';

	let {
		store,
		open = $bindable(false),
		onCreated
	}: {
		store: WorkspaceStore;
		open: boolean;
		onCreated?: (ts: Teamspace) => void;
	} = $props();

	let name = $state('');
	let icon = $state<string | null>(null);
	let about = $state('');
	let privacy = $state<Teamspace['privacy']>('open');
	let defaultLevel = $state<AccessLevel>('update');
	let busy = $state(false);

	// A fresh form each time the dialog opens.
	$effect(() => {
		if (open) {
			name = '';
			icon = null;
			about = '';
			privacy = 'open';
			defaultLevel = 'update';
			busy = false;
		}
	});

	async function submit(event?: Event) {
		event?.preventDefault();
		if (!name.trim() || busy) return;
		busy = true;
		try {
			const ts = await store.createTeamspace({ name: name.trim(), icon, description: about.trim(), privacy, defaultLevel });
			open = false;
			onCreated?.(ts);
		} catch {
			// the store has raised the toast
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open size="small" closable>
	{#snippet title()}New teamspace{/snippet}
	{#snippet description()}A teamspace is a shared home for a team's pages. You become its owner.{/snippet}
	{#snippet children()}
		<form class="flex flex-col gap-4 pt-1 pb-2" onsubmit={submit} data-testid="create-teamspace-dialog">
			<div class="flex items-end gap-2">
				<IconPicker current={icon} onpick={(i) => (icon = i)}>
					{#snippet button({ attach })}
						<button
							type="button"
							class="grid size-[var(--app-input-height)] shrink-0 place-items-center rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] text-xl hover:bg-[color:var(--app-hover)]"
							aria-label="Choose an icon"
							data-testid="teamspace-icon-button"
							{@attach attach}
						>
							{icon ?? '👥'}
						</button>
					{/snippet}
				</IconPicker>
				<div class="min-w-0 flex-1">
					<TextInput label="Name" placeholder="Engineering, Design, Marketing" bind:value={name} inputAttrs={{ 'data-testid': 'teamspace-name-input', maxlength: 100 }} />
				</div>
			</div>
			<TextArea label="Description" placeholder="What is this teamspace for? (optional)" rows={2} value={about} onValueChange={(v) => (about = v ?? '')} maxLength={1000} />

			<fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
				<legend class="mb-1 p-0 text-sm font-medium">Privacy</legend>
				{#each PRIVACY_OPTIONS as p (p.value)}
					<label
						class="flex cursor-pointer items-start gap-2 rounded-[var(--app-radius-control)] border px-2.5 py-2 text-sm {privacy === p.value
							? 'border-[color:var(--app-accent)] bg-[color:var(--app-hover)]'
							: 'border-[color:var(--app-hairline)] hover:bg-[color:var(--app-hover)]'}"
					>
						<input type="radio" name="privacy" value={p.value} bind:group={privacy} class="mt-0.5 accent-[color:var(--app-accent)]" />
						<span class="flex flex-col">
							<span class="font-medium">{p.label}</span>
							<span class="text-xs text-[color:var(--app-text-secondary)]">{p.hint}</span>
						</span>
					</label>
				{/each}
			</fieldset>

			<div class="flex items-center justify-between gap-3 text-sm">
				<span class="flex flex-col">
					<span class="font-medium">Default access</span>
					<span class="text-xs text-[color:var(--app-text-secondary)]">What members can do on the teamspace's pages.</span>
				</span>
				<LevelSelect value={defaultLevel} label="Default access of members" onchange={(l) => (defaultLevel = l)} testid="teamspace-default-level" />
			</div>
		</form>
	{/snippet}
	{#snippet footer()}
		<div class="flex justify-end gap-2 pt-2 pb-1">
			<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button loading={busy} disabled={!name.trim()} onclick={() => submit()} data-testid="teamspace-create-submit">Create teamspace</Button>
		</div>
	{/snippet}
</Dialog>
