<script lang="ts">
	import type { PresenceUser } from '#lib/shared/protocol.ts';
	import { userColor } from '#lib/client/runtime.ts';

	let {
		users,
		max = 3,
		size = 22
	}: {
		users: PresenceUser[];
		max?: number;
		size?: number;
	} = $props();

	const shown = $derived(users.slice(0, max));
	const extra = $derived(users.length - shown.length);
	const initials = (name: string) =>
		name
			.split(/\s+/)
			.map((p) => p[0])
			.filter(Boolean)
			.slice(0, 2)
			.join('')
			.toUpperCase();
</script>

{#if users.length}
	<span class="flex shrink-0 items-center" aria-label={`${users.map((u) => u.name).join(', ')} here now`} data-testid="presence">
		{#each shown as user, i (user.userId)}
			<span
				class="grid place-items-center rounded-full font-semibold text-white ring-2 ring-[color:var(--app-page)]"
				style="width:{size}px; height:{size}px; font-size:{Math.round(size * 0.42)}px; background:{user.color ?? userColor(user.userId)}; margin-left:{i ? -size * 0.3 : 0}px"
				title={user.name}
			>
				{initials(user.name)}
			</span>
		{/each}
		{#if extra > 0}
			<span class="ml-1 text-xs text-[color:var(--app-text-tertiary)]">+{extra}</span>
		{/if}
	</span>
{/if}
