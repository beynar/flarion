<script lang="ts">
	import '../app.css';
	import { Theme } from 'entasis/theme';
	import { Toaster } from 'entasis/toast';
	import { setButtonTheme } from 'entasis/button';
	import { designTokens } from '#lib/design/generated/design-tokens.ts';
	import { onMount } from 'svelte';
	import { cspNonce, stampStyleNonce } from '#lib/client/csp.ts';

	let { data, children } = $props();

	// The page is interactive from here: the server HTML is live markup before this (links work), but nothing runs. The marker is what the
	// browser tests wait for before they type into a field the server rendered, and what a visible loading state keys off.
	onMount(() => {
		document.documentElement.dataset.hydrated = 'true';
	});

	// Run-time stylesheets of libraries (edytor's comment highlight) need the document's nonce under the production policy.
	stampStyleNonce();

	// Notion's buttons are 28px (24px small). entasis shares `--control-height-*` between buttons
	// and inputs (32px), so the button height is a component override that reads the token variable.
	setButtonTheme({
		root: {
			size: {
				small: 'h-[var(--app-button-height-small)]',
				normal: 'h-[var(--app-button-height)]'
			}
		}
	});
</script>

<svelte:head>
	<title>Flarion</title>
</svelte:head>

<!-- designTokens: 16px type base at every width, raisedWithBorder off, neutral/neutral/primary
     roles and 100/150ms motion. The `edytor-notion` wrapper scopes edytor's document theme. -->
<Theme {designTokens} nonce={data.nonce ?? cspNonce()}>
	<div class="edytor-notion app-root">
		{@render children()}
	</div>
	<Toaster />
</Theme>

<style>
	.app-root {
		min-height: 100dvh;
		background: var(--app-page);
	}
</style>
