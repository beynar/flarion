import { describe, expect, test } from 'vitest';
import { LevelMap } from '../../../src/server/objects/workspace/level-map';

describe('LevelMap', () => {
	test('behaves like the Map<num, rank> it replaces', () => {
		const levels = new LevelMap([
			[3, 0],
			[10, 3],
			[70_000, 2]
		]);
		expect(levels.size).toBe(3);
		expect(levels.get(10)).toBe(3);
		expect(levels.get(3)).toBe(0);
		expect(levels.get(4)).toBeUndefined();
		expect(levels.has(3)).toBe(true);
		expect(levels.has(70_001)).toBe(false);
		expect([...levels.keys()]).toEqual([3, 10, 70_000]);
		expect([...levels]).toEqual([
			[3, 0],
			[10, 3],
			[70_000, 2]
		]);
		levels.set(10, 1);
		expect(levels.get(10)).toBe(1);
		expect(levels.size).toBe(3);
		expect(levels.delete(10)).toBe(true);
		expect(levels.delete(10)).toBe(false);
		expect(levels.delete(9_999_999)).toBe(false);
		expect(levels.size).toBe(2);
	});

	test('the Set-shaped view reads through, copy-free', () => {
		const levels = new LevelMap([
			[5, 0],
			[6, 1]
		]);
		const set = levels.asSet();
		expect(set.has(5)).toBe(true);
		expect(set.size).toBe(2);
		levels.delete(5);
		expect(set.has(5)).toBe(false);
		expect(set.size).toBe(1);
		expect([...set]).toEqual([6]);
	});

	test('50,000 pages take about 50 KB of rank bytes, not a map', () => {
		const levels = new LevelMap();
		for (let n = 1; n <= 50_000; n++) levels.set(n, n % 4);
		expect(levels.size).toBe(50_000);
		for (let n = 1; n <= 50_000; n += 997) expect(levels.get(n)).toBe(n % 4);
	});
});
