<script lang="ts">
	import { Button } from 'entasis/button';
	import { Dialog } from 'entasis/dialog';
	import { RadioInput } from 'entasis/radio-input';
	import { Select } from 'entasis/select';
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import type { Teamspace } from '#lib/shared/schemas.ts';
	import IconPicker from '#lib/components/pickers/IconPicker.svelte';
	import { LEVELS, PRIVACY_OPTIONS } from './levels.ts';

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
						<!-- The teamspace emoji is not an entasis Avatar (image or initials only): it is the button's content. -->
						<Button
							variant="outline"
							squared
							class="size-[var(--app-input-height)] shrink-0 text-xl"
							label="Choose an icon"
							data-testid="teamspace-icon-button"
							{@attach attach}
						>
							{icon ?? '👥'}
						</Button>
					{/snippet}
				</IconPicker>
				<div class="min-w-0 flex-1">
					<TextInput label="Name" placeholder="Engineering, Design, Marketing" bind:value={name} inputAttrs={{ 'data-testid': 'teamspace-name-input', maxlength: 100 }} />
				</div>
			</div>
			<TextArea label="Description" placeholder="What is this teamspace for? (optional)" rows={2} value={about} onValueChange={(v) => (about = v ?? '')} maxLength={1000} />

			<RadioInput
				label="Privacy"
				mode="card"
				items={PRIVACY_OPTIONS.map((p) => ({ value: p.value, label: p.label, description: p.hint }))}
				value={privacy}
				onValueChange={(v) => v && (privacy = v as Teamspace['privacy'])}
			/>

			<div class="flex items-center justify-between gap-3 text-sm">
				<span class="flex flex-col">
					<span class="font-medium">Default access</span>
					<span class="text-xs text-[color:var(--app-text-secondary)]">What members can do on the teamspace's pages.</span>
				</span>
				<div class="w-40 shrink-0">
					<Select
						size="small"
						items={LEVELS}
						value={defaultLevel}
						onValueChange={(v) => v && (defaultLevel = v as AccessLevel)}
						alignItemWithTrigger={false}
						triggerAttrs={{ 'aria-label': 'Default access of members', 'data-testid': 'teamspace-default-level' }}
					/>
				</div>
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
