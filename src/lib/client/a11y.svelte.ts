/**
 * Accessibility preferences of the app. Today: contrast (docs/PLAN.md "Design system": Notion's secondary text sits a
 * little below WCAG AA, so by default it stays as Notion has it and a high-contrast setting raises the secondary and
 * tertiary text tokens). The choice is `system` (follow the OS's `prefers-contrast: more`), `high` or `default`, kept
 * in localStorage and applied as `data-contrast="high"` on `<html>`, which `generated/app-vars.css` reads.
 * Reduced motion needs no setting: the generated CSS and entasis both follow `prefers-reduced-motion`.
 */
export type ContrastChoice = 'system' | 'high' | 'default';

export const CONTRAST_KEY = 'flarion.contrast';
export const CONTRAST_CHOICES: readonly ContrastChoice[] = ['system', 'high', 'default'];

/** Whether a choice means high contrast, given what the OS asks for. */
export const resolvesHigh = (choice: ContrastChoice, systemHigh: boolean): boolean => (choice === 'system' ? systemHigh : choice === 'high');

function readChoice(): ContrastChoice {
	try {
		const stored = localStorage.getItem(CONTRAST_KEY);
		return CONTRAST_CHOICES.includes(stored as ContrastChoice) ? (stored as ContrastChoice) : 'system';
	} catch {
		return 'system';
	}
}

class A11yPrefs {
	choice = $state<ContrastChoice>('system');
	systemHigh = $state(false);
	#started = false;

	get high(): boolean {
		return resolvesHigh(this.choice, this.systemHigh);
	}

	/** Reads the saved choice and the OS preference, applies them, and follows the OS. Safe to call more than once. */
	start(): void {
		if (this.#started || typeof document === 'undefined') return;
		this.#started = true;
		this.choice = readChoice();
		const query = typeof matchMedia === 'function' ? matchMedia('(prefers-contrast: more)') : null;
		this.systemHigh = query?.matches ?? false;
		query?.addEventListener('change', (event) => {
			this.systemHigh = event.matches;
			this.apply();
		});
		this.apply();
	}

	set(choice: ContrastChoice): void {
		this.choice = choice;
		try {
			localStorage.setItem(CONTRAST_KEY, choice);
		} catch {
			// private mode: the choice lasts until the page closes
		}
		this.apply();
	}

	apply(): void {
		if (typeof document === 'undefined') return;
		if (this.high) document.documentElement.dataset.contrast = 'high';
		else delete document.documentElement.dataset.contrast;
	}
}

export const a11yPrefs = new A11yPrefs();
// Applied as soon as the module loads, so the first paint after a reload already has the right text colors.
a11yPrefs.start();
