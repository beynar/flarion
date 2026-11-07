import { describe, expect, test } from 'vitest';
import { toFilter } from '../../../src/server/auth/viborm-adapter';

const c = (field: string, value: unknown, extra: Record<string, unknown> = {}) =>
	({ field, value, operator: 'eq', connector: 'AND', mode: 'sensitive', ...extra }) as never;

describe('better-auth where -> viborm filter', () => {
	test('nothing matches everything', () => {
		expect(toFilter(undefined)).toEqual({});
		expect(toFilter([])).toEqual({});
	});
	test('a single clause is flat; several are ANDed', () => {
		expect(toFilter([c('id', 'a')])).toEqual({ id: { equals: 'a' } });
		expect(toFilter([c('id', 'a'), c('userId', 'u')])).toEqual({ AND: [{ id: { equals: 'a' } }, { userId: { equals: 'u' } }] });
	});
	test('null comparisons', () => {
		expect(toFilter([c('image', null)])).toEqual({ image: null });
		expect(toFilter([c('image', null, { operator: 'ne' })])).toEqual({ image: { not: null } });
	});
	test('operators map to viborm names and case-insensitivity only applies to strings', () => {
		expect(toFilter([c('a', ['x'], { operator: 'in' })])).toEqual({ a: { in: ['x'] } });
		expect(toFilter([c('a', ['x'], { operator: 'not_in' })])).toEqual({ a: { notIn: ['x'] } });
		expect(toFilter([c('a', 'x', { operator: 'starts_with', mode: 'insensitive' })])).toEqual({ a: { startsWith: 'x', mode: 'insensitive' } });
		expect(toFilter([c('a', 3, { operator: 'gte', mode: 'insensitive' })])).toEqual({ a: { gte: 3 } });
		expect(toFilter([c('a', 3, { mode: 'insensitive' })])).toEqual({ a: { equals: 3 } });
	});
	test('OR clauses group together and are ANDed with the AND group', () => {
		const filter = toFilter([c('a', 1), c('b', 2, { connector: 'OR' }), c('b', 3, { connector: 'OR' })]);
		expect(filter).toEqual({ AND: [{ a: { equals: 1 } }, { OR: [{ b: { equals: 2 } }, { b: { equals: 3 } }] }] });
		expect(toFilter([c('b', 2, { connector: 'OR' })])).toEqual({ OR: [{ b: { equals: 2 } }] });
	});
	test('"in" needs an array', () => {
		expect(() => toFilter([c('a', 'x', { operator: 'in' })])).toThrow();
	});
});
