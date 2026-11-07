<script lang="ts">
	/** Flarion's own mark: a rounded square holding an F whose crossbar ends in a spark. */
	let { size = 20, class: className = '' }: { size?: number; class?: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	class={className}
	aria-hidden="true"
	role="img"
>
	<rect width="24" height="24" rx="6" fill="#2383e2" />
	<path d="M7.5 6h9v2.6h-6v2h4.6v2.5h-4.6V18H7.5z" fill="#fff" />
	<circle cx="17.2" cy="16.2" r="1.7" fill="#fff" />
</svg>
