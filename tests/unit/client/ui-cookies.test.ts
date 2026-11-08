import { describe, expect, it } from 'vitest';
import { emptyUi, parseUiCookie, serializeUiCookie, uiCookieName } from '#lib/client/ui-cookies.ts';

describe('the interface cookie the server render reads', () => {
	it('is named per workspace', () => {
		expect(uiCookieName('abc')).toBe('fl_ui_abc');
	});

	it('round-trips favorites, recents, expanded branches and folded sections', () => {
		const state = { fav: ['p1', 'p2'], rec: [['p3', 1700000000000]] as [string, number][], exp: ['p4'], fold: ['shared', 'ts:t1'] };
		expect(parseUiCookie(serializeUiCookie(state))).toEqual(state);
	});

	it('reads a decoded value too (SvelteKit decodes cookies)', () => {
		expect(parseUiCookie(JSON.stringify({ fav: ['p1'] }))).toEqual({ ...emptyUi(), fav: ['p1'] });
	});

	it('treats anything malformed as empty and drops ids that are not ids', () => {
		expect(parseUiCookie(undefined)).toEqual(emptyUi());
		expect(parseUiCookie('%7Bnot json')).toEqual(emptyUi());
		expect(parseUiCookie(JSON.stringify({ fav: ['ok', '<script>', 42], rec: [['a', 1], ['bad id', 2], 'x'], exp: 'nope' }))).toEqual({ fav: ['ok'], rec: [['a', 1]], exp: [], fold: [] });
	});

	it('trims the least important parts to stay under the cookie size', () => {
		const big = { fav: [], rec: Array.from({ length: 30 }, (_, i): [string, number] => [`page-${'x'.repeat(40)}${i}`, i]), exp: Array.from({ length: 60 }, (_, i) => `branch-${'y'.repeat(40)}${i}`), fold: [] };
		expect(serializeUiCookie(big).length).toBeLessThanOrEqual(3600 + 200);
		expect(parseUiCookie(serializeUiCookie(big)).rec.length).toBeGreaterThan(0);
	});
});
