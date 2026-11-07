<!-- A card's cover: a preset gradient or an image, filling its box. -->
<script lang="ts">
	let { cover, height = 110 }: { cover: { image: string; isImage: boolean } | null; height?: number } = $props();
</script>

{#if cover}
	<div class="cover" style="height: {height}px; background-image: {cover.image}" role="img" aria-label="Cover" data-testid="card-cover"></div>
{/if}

<style>
	.cover {
		width: 100%;
		background-size: cover;
		background-position: center;
		background-color: var(--app-hover);
	}
</style>
