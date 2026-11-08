import { describe, expect, test } from 'vitest';
import { loadTestAuthEnabled, safeEqual } from '../../../src/server/auth/load-test-guard';

const KEY = 'k'.repeat(32);

describe('loadTestAuthEnabled', () => {
	test('staging with a long enough key is the one place it is on, whatever the host', () => {
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging', LOAD_TEST_KEY: KEY })).toBe(true);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging', LOAD_TEST_KEY: KEY }, 'flarion-staging.beynar.workers.dev')).toBe(true);
	});

	test('production is impossible, key or not, localhost or not', () => {
		for (const host of [undefined, 'flarion.beynar.dev', 'localhost', '127.0.0.1']) {
			expect(loadTestAuthEnabled({ ENVIRONMENT: 'production', LOAD_TEST_KEY: KEY }, host)).toBe(false);
		}
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'production' })).toBe(false);
	});

	test('test and unknown environments are impossible', () => {
		for (const ENVIRONMENT of ['test', 'preview', 'Production', 'STAGING', '']) {
			expect(loadTestAuthEnabled({ ENVIRONMENT, LOAD_TEST_KEY: KEY }, 'localhost')).toBe(false);
		}
	});

	test('a missing, empty or short key keeps staging closed', () => {
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging' })).toBe(false);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging', LOAD_TEST_KEY: '' })).toBe(false);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging', LOAD_TEST_KEY: 'short' })).toBe(false);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'staging', LOAD_TEST_KEY: 'x'.repeat(23) })).toBe(false);
	});

	test('development needs the key and a loopback host', () => {
		for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(loadTestAuthEnabled({ ENVIRONMENT: 'development', LOAD_TEST_KEY: KEY }, host)).toBe(true);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'development', LOAD_TEST_KEY: KEY }, 'example.com')).toBe(false);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'development', LOAD_TEST_KEY: KEY })).toBe(false);
		expect(loadTestAuthEnabled({ ENVIRONMENT: 'development' }, 'localhost')).toBe(false);
	});
});

describe('safeEqual', () => {
	test('equal strings match, any difference does not', () => {
		expect(safeEqual(KEY, KEY)).toBe(true);
		expect(safeEqual(KEY, `${KEY}x`)).toBe(false);
		expect(safeEqual(KEY, KEY.slice(1))).toBe(false);
		expect(safeEqual(KEY, `${KEY.slice(0, -1)}z`)).toBe(false);
		expect(safeEqual('', '')).toBe(true);
	});
});
