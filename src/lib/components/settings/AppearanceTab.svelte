<script lang="ts">
	import { RadioInput } from 'entasis/radio-input';
	import { useTheme } from 'entasis/theme';
	import { a11yPrefs, type ContrastChoice } from '#lib/client/a11y.svelte.ts';

	/**
	 * Settings > Appearance: the color theme and the high-contrast setting. High contrast raises the secondary and
	 * tertiary text tokens to at least 4.5:1 (Notion's defaults sit a little below); "Match system" follows the OS.
	 */
	const theme = useTheme();
	const modes = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'system', label: 'Match system' }
	];
	const contrasts = [
		{ value: 'system', label: 'Match system', description: 'High contrast when your device asks for more contrast.' },
		{ value: 'default', label: 'Standard', description: 'Notion’s softer secondary text.' },
		{ value: 'high', label: 'High contrast', description: 'Darker secondary and tertiary text: captions, placeholders and labels meet 4.5:1.' }
	];
</script>

<div class="flex max-w-[560px] flex-col gap-8" data-testid="appearance-tab">
	<RadioInput
		label="Theme"
		items={modes}
		value={theme.theme ?? 'system'}
		onValueChange={(value) => value && (theme.theme = value)}
		fieldAttrs={{ 'data-testid': 'appearance-theme' }}
	/>
	<RadioInput
		label="Contrast"
		mode="card"
		items={contrasts}
		value={a11yPrefs.choice}
		onValueChange={(value) => value && a11yPrefs.set(value as ContrastChoice)}
		fieldAttrs={{ 'data-testid': 'appearance-contrast' }}
	/>
	<p class="m-0 text-sm text-[color:var(--app-text-secondary)]">
		Animations follow your device’s “reduce motion” setting.
	</p>
</div>
