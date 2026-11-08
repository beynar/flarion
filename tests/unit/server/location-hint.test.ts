import { describe, expect, test } from 'vitest';
import { LOCATION_HINTS, locationHintFor, parseLocationHint, workspaceStubWithHint } from '../../../src/server/objects/workspace/location';

describe('locationHintFor', () => {
	test('maps where the creator is to a Durable Object region', () => {
		expect(locationHintFor({ continent: 'NA', country: 'US', longitude: '-122.4' })).toBe('wnam');
		expect(locationHintFor({ continent: 'NA', country: 'US', longitude: '-74.0' })).toBe('enam');
		expect(locationHintFor({ continent: 'NA', country: 'CA' })).toBe('enam');
		expect(locationHintFor({ continent: 'SA', country: 'BR' })).toBe('sam');
		expect(locationHintFor({ continent: 'EU', country: 'FR', longitude: '2.35' })).toBe('weur');
		expect(locationHintFor({ continent: 'EU', country: 'PL', longitude: '21.0' })).toBe('eeur');
		expect(locationHintFor({ continent: 'EU', country: 'TR', longitude: '29.0' })).toBe('me');
		expect(locationHintFor({ continent: 'AS', country: 'JP' })).toBe('apac');
		expect(locationHintFor({ continent: 'AS', country: 'AE' })).toBe('me');
		expect(locationHintFor({ continent: 'AF', country: 'ZA' })).toBe('afr');
		expect(locationHintFor({ continent: 'OC', country: 'AU' })).toBe('oc');
	});

	test('says nothing without usable geography (local dev, tests, Antarctica)', () => {
		expect(locationHintFor(undefined)).toBeUndefined();
		expect(locationHintFor(null)).toBeUndefined();
		expect(locationHintFor({})).toBeUndefined();
		expect(locationHintFor({ continent: 'AN' })).toBeUndefined();
	});
});

describe('workspaceStubWithHint', () => {
	const namespace = () => {
		const calls: unknown[][] = [];
		return { calls, ns: { getByName: (...args: unknown[]) => (calls.push(args), { stub: true }) } as unknown as DurableObjectNamespace };
	};

	test('passes the hint to the first contact, and nothing without one', () => {
		const a = namespace();
		workspaceStubWithHint(a.ns, 'ws-1', 'weur');
		expect(a.calls).toEqual([['ws-1', { locationHint: 'weur' }]]);
		const b = namespace();
		workspaceStubWithHint(b.ns, 'ws-2');
		expect(b.calls).toEqual([['ws-2']]);
	});
});

describe('parseLocationHint', () => {
	test('accepts exactly the regions Cloudflare knows, and nothing else', () => {
		for (const hint of LOCATION_HINTS) expect(parseLocationHint(hint)).toBe(hint);
		expect(parseLocationHint('europe')).toBeUndefined();
		expect(parseLocationHint('')).toBeUndefined();
		expect(parseLocationHint(undefined)).toBeUndefined();
		expect(parseLocationHint(3)).toBeUndefined();
	});

	test('every continent of request.cf maps to a hint, deterministically', () => {
		const answer = (cf: Parameters<typeof locationHintFor>[0]) => [locationHintFor(cf), locationHintFor(cf)];
		for (const [cf, hint] of [
			[{ continent: 'EU', country: 'FR', longitude: '5.4' }, 'weur'],
			[{ continent: 'NA', country: 'US', longitude: '-74' }, 'enam'],
			[{ continent: 'AS', country: 'SG' }, 'apac'],
			[{ continent: 'OC', country: 'AU' }, 'oc'],
			[{ continent: 'SA', country: 'BR' }, 'sam'],
			[{ continent: 'AF', country: 'ZA' }, 'afr']
		] as const) expect(answer(cf)).toEqual([hint, hint]);
	});
});
