import { describe, expect, it } from 'vitest';
import { notion } from '../../src/lib/design/notion.tokens.ts';

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
	const hex = /^#([0-9a-f]{6})$/i.exec(color);
	if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
	const m = /rgba?\(([^)]+)\)/.exec(color);
	if (!m) throw new Error(`cannot parse ${color}`);
	const [r, g, b, a = 1] = m[1]!.split(',').map(Number);
	return [r!, g!, b!, a];
}
const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => {
	const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG contrast of `fg` (may be translucent) on the opaque `bg`. */
function ratio(fg: string, bg: string): number {
	const back = parse(bg);
	const [hi, lo] = [luminance(over(parse(fg), back)), luminance(back)].sort((a, b) => b - a);
	return (hi! + 0.05) / (lo! + 0.05);
}

const { core, highContrast, blockColors } = notion;
const SURFACES = (theme: 'light' | 'dark') => [
	core.page[theme],
	core.sidebar[theme],
	core.calloutPanel[theme],
	core.codePanel[theme],
	blockColors.gray.background[theme]
];

describe.each(['light', 'dark'] as const)('high-contrast text tokens (%s)', (theme) => {
	it.each([
		['textSecondary', highContrast.textSecondary[theme]],
		['textTertiary', highContrast.textTertiary[theme]],
		['textSidebar', highContrast.textSidebar[theme]]
	])('%s keeps 4.5:1 on every surface', (_name, color) => {
		for (const surface of SURFACES(theme)) expect(ratio(color, surface), `${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
	});

	it('is stronger than the default it replaces', () => {
		expect(ratio(highContrast.textSecondary[theme], core.page[theme])).toBeGreaterThan(ratio(core.textSecondary[theme], core.page[theme]));
		expect(ratio(highContrast.textTertiary[theme], core.page[theme])).toBeGreaterThan(ratio(core.textTertiary[theme], core.page[theme]));
	});
});

describe('the defaults stay Notion\'s', () => {
	it('tertiary text sits below AA by default (the reason for the setting)', () => {
		expect(ratio(core.textTertiary.light, core.page.light)).toBeLessThan(4.5);
		expect(ratio(core.textTertiary.dark, core.page.dark)).toBeLessThan(4.5);
	});
	it('body text is comfortably above it', () => {
		expect(ratio(core.text.light, core.page.light)).toBeGreaterThan(10);
		expect(ratio(core.text.dark, core.page.dark)).toBeGreaterThan(10);
	});
});
