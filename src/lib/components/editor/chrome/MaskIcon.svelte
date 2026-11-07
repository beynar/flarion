<script lang="ts">
	/** One of the chrome's line icons (`icons.ts`: an SVG data URL), drawn in the text color through a CSS mask. */
	let { icon, glyph, size = 20 }: { icon?: string; glyph?: string; size?: number } = $props();
</script>

{#if icon}
	<span
		aria-hidden="true"
		class="inline-block shrink-0 bg-current"
		style="width: {size}px; height: {size}px; -webkit-mask: {icon} center / {size}px no-repeat; mask: {icon} center / {size}px no-repeat"
	></span>
{:else}
	<span aria-hidden="true" class="inline-grid shrink-0 place-items-center text-[13px] leading-none font-semibold" style="width: {size}px; height: {size}px">{glyph}</span>
{/if}
