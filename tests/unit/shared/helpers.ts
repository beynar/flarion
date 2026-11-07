/** Seeded PRNG and small generators for the property tests. */
export function rng(seed: number) {
	let a = seed >>> 0;
	const next = (): number => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
	const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
	const bool = (p = 0.5): boolean => next() < p;
	const shuffle = <T>(xs: readonly T[]): T[] => {
		const out = [...xs];
		for (let i = out.length - 1; i > 0; i--) {
			const j = int(0, i);
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	};
	return { next, int, pick, bool, shuffle };
}
export type Rng = ReturnType<typeof rng>;

const ALPHABET = 'abcdeABCDEéèêÉÀàçÇñÑüÜßøØæŒ 0123456789-_.ﬁ😀日本語ǅ́';
export function randomText(r: Rng, maxLen = 12): string {
	const chars = [...ALPHABET];
	let s = '';
	for (let i = r.int(0, maxLen); i > 0; i--) s += r.pick(chars);
	return s;
}
