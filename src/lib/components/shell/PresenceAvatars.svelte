<script lang="ts">
	import { Avatar, AvatarGroup } from 'entasis/avatar';
	import { Tooltip } from 'entasis/tooltip';
	import type { PresenceUser } from '#lib/shared/protocol.ts';
	import { userColor } from '#lib/client/runtime.ts';

	/**
	 * Who else is on a page: an entasis `AvatarGroup`. Each person keeps their presence color (the cursor color) on the
	 * initials through a CSS variable, and a Tooltip names everyone. `tiny` is the 16px sidebar size, `small` the top bar's.
	 */
	let {
		users,
		max = 3,
		size = 'small'
	}: {
		users: PresenceUser[];
		max?: number;
		size?: 'small' | 'tiny';
	} = $props();

	const tiny = $derived(size === 'tiny');
	const names = $derived(users.map((u) => u.name).join(', '));
	const colorOf = (user: PresenceUser) => user.color ?? userColor(user.userId);
	// The only inline color is a per-user value (a hex string), set as a variable the theme classes read.
	const tint = (color: string) => (el: HTMLElement) => el.style.setProperty('--presence-color', color);
</script>

{#if users.length}
	<Tooltip content={names} position="bottom" delay={200}>
		{#snippet trigger(attach)}
			<span class="flex shrink-0 items-center" aria-label={`${names} here now`} data-testid="presence" {@attach attach}>
				<AvatarGroup
					items={users.map((u) => ({ name: u.name, userId: u.userId, color: colorOf(u) }))}
					{max}
					size="small"
					theme={{
						root: { base: tiny ? 'ml-0 [&>[data-avatar]]:ml-[-0.2rem]' : 'ml-0' },
						avatarGroupCount: { base: tiny ? 'size-4! ml-[-0.2rem]! text-[8px]!' : '' }
					}}
				>
					{#snippet avatar({ item, avatarProps })}
						<Avatar
							{...avatarProps}
							name={item.name}
							alt=""
							theme={{
								root: { base: tiny ? 'size-4! ring-0!' : 'ring-2 ring-[color:var(--app-page)]' },
								avatarInitials: { base: `bg-[var(--presence-color)]! text-white! ${tiny ? 'text-[8px]!' : ''}` }
							}}
							{@attach tint(item.color)}
						/>
					{/snippet}
				</AvatarGroup>
			</span>
		{/snippet}
	</Tooltip>
{/if}
