<script lang="ts">
	import '../app.css';
	import { Theme } from 'entasis/theme';
	import { Toaster } from 'entasis/toast';
	import { setButtonTheme } from 'entasis/button';
	import { designTokens } from '#lib/design/generated/design-tokens.ts';
	import { cspNonce } from '#lib/client/csp.ts';

	let { children } = $props();

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
<Theme {designTokens} nonce={cspNonce()}>
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
