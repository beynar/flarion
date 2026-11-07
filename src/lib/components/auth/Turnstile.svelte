<script lang="ts">
	/**
	 * Cloudflare Turnstile widget (explicit render). `token` is bound to the solved token. With Cloudflare's
	 * test site key (dev, tests) a widget that cannot load (offline) falls back to the documented dummy token,
	 * which the server accepts only with a test secret.
	 */
	import { onMount } from 'svelte';
	import { loadAuthConfig } from '#lib/client/auth.ts';

	let { token = $bindable(''), resetKey = 0 }: { token?: string; resetKey?: number } = $props();

	const TEST_SITE_KEYS = ['1x00000000000000000000AA', '2x00000000000000000000AB', '3x00000000000000000000FF'];
	const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

	type TurnstileApi = {
		render(el: HTMLElement, options: Record<string, unknown>): string;
		reset(id?: string): void;
		remove(id?: string): void;
	};

	let container: HTMLDivElement | undefined = $state();
	let widgetId: string | undefined;
	let failed = $state(false);

	function loadScript(): Promise<TurnstileApi | null> {
		const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), 4000);
			const script = document.createElement('script');
			script.src = SCRIPT;
			script.async = true;
			script.onload = () => {
				clearTimeout(timer);
				resolve((window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null);
			};
			script.onerror = () => {
				clearTimeout(timer);
				resolve(null);
			};
			document.head.appendChild(script);
		});
	}

	onMount(() => {
		let cancelled = false;
		void (async () => {
			const config = await loadAuthConfig();
			const api = await loadScript();
			if (cancelled) return;
			if (!api || !container) {
				if (TEST_SITE_KEYS.includes(config.turnstileSiteKey)) token = 'XXXX.DUMMY.TOKEN.XXXX';
				else failed = true;
				return;
			}
			widgetId = api.render(container, {
				sitekey: config.turnstileSiteKey,
				theme: 'auto',
				callback: (value: string) => (token = value),
				'expired-callback': () => (token = ''),
				'error-callback': () => {
					if (TEST_SITE_KEYS.includes(config.turnstileSiteKey)) token = 'XXXX.DUMMY.TOKEN.XXXX';
					else failed = true;
				}
			});
		})();
		return () => {
			cancelled = true;
			const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
			if (widgetId && api) api.remove(widgetId);
		};
	});

	// A parent bumps `resetKey` after a failed submit: Turnstile tokens are single use.
	let lastReset: number | undefined;
	$effect(() => {
		const key = resetKey;
		if (lastReset === undefined) {
			lastReset = key;
			return;
		}
		if (key === lastReset) return;
		lastReset = key;
		token = '';
		const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
		if (widgetId && api) api.reset(widgetId);
		else if (!widgetId) token = 'XXXX.DUMMY.TOKEN.XXXX';
	});
</script>

<div class="flex min-h-[65px] items-center justify-center" data-testid="turnstile">
	<div bind:this={container}></div>
	{#if failed}
		<p class="text-sm text-[color:var(--app-text-secondary)]">Verification could not load. Reload the page and try again.</p>
	{/if}
</div>
