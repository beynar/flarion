<script lang="ts">
	import { Chip } from 'entasis/chip';
	import type { BlockColorName } from '#lib/design/notion.tokens.ts';

	/**
	 * A select or status option, rendered by entasis `Chip` (soft, small). `Chip.color` only takes the 7 semantic
	 * colors and Notion's option palette has 9 (audit NE-4), so the colors reach the Chip through its `theme` override as
	 * `--app-option-<name>-bg/fg` classes. The map is spelled out so Tailwind sees every class.
	 */
	let { color = 'gray', label }: { color?: BlockColorName | string; label: string } = $props();

	const COLORS: Record<string, string> = {
		gray: 'bg-[var(--app-option-gray-bg)]! text-[var(--app-option-gray-fg)]!',
		brown: 'bg-[var(--app-option-brown-bg)]! text-[var(--app-option-brown-fg)]!',
		orange: 'bg-[var(--app-option-orange-bg)]! text-[var(--app-option-orange-fg)]!',
		yellow: 'bg-[var(--app-option-yellow-bg)]! text-[var(--app-option-yellow-fg)]!',
		green: 'bg-[var(--app-option-green-bg)]! text-[var(--app-option-green-fg)]!',
		blue: 'bg-[var(--app-option-blue-bg)]! text-[var(--app-option-blue-fg)]!',
		purple: 'bg-[var(--app-option-purple-bg)]! text-[var(--app-option-purple-fg)]!',
		pink: 'bg-[var(--app-option-pink-bg)]! text-[var(--app-option-pink-fg)]!',
		red: 'bg-[var(--app-option-red-bg)]! text-[var(--app-option-red-fg)]!'
	};
	// 20px tall, 3px corners, 14px text: the Notion tag metrics from the token file.
	const SHAPE =
		'h-[var(--app-tag-height)]! max-w-full! rounded-[var(--app-tag-radius)]! px-1.5! text-sm! font-normal! leading-none!';
</script>

<Chip variant="soft" size="small" theme={{ root: { base: `${SHAPE} ${COLORS[color] ?? COLORS.gray}` } }}>
	<span class="truncate">{label}</span>
</Chip>
