/**
 * Trailing debounce for the title: the last value typed within `ms` is sent once (last writer wins).
 * `flush` sends a pending value now (blur, Enter, unmount) and `cancel` drops it (the page was replaced).
 */
export interface Debounced<T> {
	schedule(value: T): void;
	flush(): void;
	cancel(): void;
	readonly pending: boolean;
}

export function debounced<T>(send: (value: T) => void, ms: number): Debounced<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let held: { value: T } | undefined;
	const fire = () => {
		timer = undefined;
		if (!held) return;
		const { value } = held;
		held = undefined;
		send(value);
	};
	return {
		schedule(value) {
			held = { value };
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(fire, ms);
		},
		flush() {
			if (timer !== undefined) clearTimeout(timer);
			fire();
		},
		cancel() {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			held = undefined;
		},
		get pending() {
			return held !== undefined;
		}
	};
}

export const TITLE_DEBOUNCE_MS = 300;
