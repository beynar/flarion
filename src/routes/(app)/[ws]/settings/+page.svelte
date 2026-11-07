<script lang="ts">
	import { Avatar } from 'entasis/avatar';
	import { members } from '#lib/client/mock.ts';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';

	const sections = ['Members', 'Teamspaces', 'Passkeys', 'API tokens'];
</script>

<svelte:head><title>Settings · Flarion</title></svelte:head>

<div
	class="mx-auto w-full max-w-[900px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]"
>
	<h1 class="mb-1 text-3xl font-semibold tracking-tight">Settings</h1>
	<p class="mb-6 text-sm text-[color:var(--app-text-secondary)]">
		Stub: Members, teamspaces, passkeys and API tokens each get a Data table and dialogs later.
	</p>

	<nav class="mb-6 flex gap-1 overflow-x-auto border-b border-[color:var(--app-hairline)] pb-2" aria-label="Settings sections">
		{#each sections as name, index (name)}
			<span
				class="rounded px-2 text-sm"
				class:bg-[color:var(--app-active)]={index === 0}
				class:text-[color:var(--app-text-secondary)]={index !== 0}
				style="line-height: var(--app-row-height)"
			>
				{name}
			</span>
		{/each}
	</nav>

	<ul class="flex flex-col">
		{#each members as member (member.email)}
			<li class="flex items-center gap-3 text-sm" style="min-height: var(--app-table-row-height)">
				<Avatar size="small" name={member.name} />
				<span class="min-w-0 flex-1 truncate">{member.name}</span>
				<span class="hidden truncate text-xs text-[color:var(--app-text-tertiary)] md:inline">
					{member.email}
				</span>
				<OptionTag color={member.role === 'Owner' ? 'purple' : member.role === 'Admin' ? 'blue' : 'gray'} label={member.role} />
			</li>
		{/each}
	</ul>
</div>
