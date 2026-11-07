/**
 * better-auth database adapter over viborm (docs/PLAN.md "Database adapter"), built with better-auth's
 * `createAdapterFactory`. Auth tables share the D1 schema in `db/global.schema.ts`, so migrations are the
 * generated SQL in `migrations/d1/`.
 *
 * - Model keys and field names of the viborm schema are better-auth's own, so no renaming is needed.
 * - D1 has no interactive transactions: `transaction: false`, better-auth then runs the callback
 *   sequentially (passkey registration with `createSession` is still safe because the user and the passkey
 *   are created before the session).
 * - `consumeOne` and `incrementOne` use the factory's guarded fallbacks (snapshot-guarded `deleteMany`
 *   that must affect exactly one row), which is race-safe on D1.
 * - `where` arrays follow the drizzle adapter's grouping: the AND-connected clauses are ANDed together and
 *   the OR-connected ones are ORed together, then both groups are ANDed.
 */
import { createAdapterFactory } from 'better-auth/adapters';
import type { BetterAuthOptions } from 'better-auth';
import type { GlobalClient } from '../db/global.client';

type Row = Record<string, unknown>;
type Delegate = {
	create(args: { data: Row }): Promise<Row>;
	findFirst(args: Row): Promise<Row | null>;
	findMany(args: Row): Promise<Row[]>;
	update(args: { where: Row; data: Row }): Promise<Row>;
	updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
	deleteMany(args: { where: Row }): Promise<{ count: number }>;
	count(args: { where: Row }): Promise<number>;
};

/** A where clause as the factory hands it to custom adapters (operators and mode are always set). */
interface Clause {
	field: string;
	value: unknown;
	operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with';
	connector: 'AND' | 'OR';
	mode: 'sensitive' | 'insensitive';
}

export interface VibormAdapterConfig {
	debugLogs?: boolean;
}

function condition(clause: Clause): Row {
	const { field, value, operator } = clause;
	const insensitive =
		clause.mode === 'insensitive' &&
		(typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string')));
	const mode = insensitive ? { mode: 'insensitive' } : {};
	switch (operator) {
		case 'in':
			if (!Array.isArray(value)) throw new Error(`The "in" operator on "${field}" needs an array`);
			return { [field]: { in: value, ...mode } };
		case 'not_in':
			if (!Array.isArray(value)) throw new Error(`The "not_in" operator on "${field}" needs an array`);
			return { [field]: { notIn: value, ...mode } };
		case 'contains':
			return { [field]: { contains: value, ...mode } };
		case 'starts_with':
			return { [field]: { startsWith: value, ...mode } };
		case 'ends_with':
			return { [field]: { endsWith: value, ...mode } };
		case 'lt':
		case 'lte':
		case 'gt':
		case 'gte':
			return { [field]: { [operator]: value } };
		case 'ne':
			return { [field]: { not: value, ...mode } };
		default:
			if (value === null) return { [field]: null };
			return { [field]: { equals: value, ...mode } };
	}
}

/** Translates better-auth's flat where list into a viborm filter. */
export function toFilter(where: readonly Clause[] | undefined): Row {
	if (!where?.length) return {};
	const and = where.filter((clause) => clause.connector !== 'OR').map(condition);
	const or = where.filter((clause) => clause.connector === 'OR').map(condition);
	if (and.length && or.length) return { AND: [...and, { OR: or }] };
	if (or.length) return { OR: or };
	return and.length === 1 ? (and[0] as Row) : { AND: and };
}

function selection(select: string[] | undefined): Row {
	return select?.length ? { select: Object.fromEntries(select.map((field) => [field, true])) } : {};
}

export function vibormAdapter(db: GlobalClient, config: VibormAdapterConfig = {}) {
	const model = (name: string): Delegate => {
		const delegate = (db as unknown as Record<string, Delegate | undefined>)[name];
		if (!delegate) throw new Error(`viborm adapter: unknown model "${name}"`);
		return delegate;
	};

	return createAdapterFactory<BetterAuthOptions>({
		config: {
			adapterId: 'viborm',
			adapterName: 'viborm (D1)',
			usePlural: false,
			debugLogs: config.debugLogs ?? false,
			supportsNumericIds: false,
			supportsJSON: false,
			supportsArrays: false,
			supportsDates: true,
			supportsBooleans: true,
			// D1 only runs atomic batches in viborm: no callback transactions.
			transaction: false
		},
		adapter: () => ({
			async create({ model: name, data }) {
				return (await model(name).create({ data: data as Row })) as typeof data;
			},
			async findOne({ model: name, where, select }) {
				return (await model(name).findFirst({ where: toFilter(where), ...selection(select) })) as never;
			},
			async findMany({ model: name, where, limit, select, sortBy, offset }) {
				return (await model(name).findMany({
					where: toFilter(where),
					take: limit,
					...(offset ? { skip: offset } : {}),
					...(sortBy ? { orderBy: { [sortBy.field]: sortBy.direction } } : {}),
					...selection(select)
				})) as never;
			},
			async count({ model: name, where }) {
				return await model(name).count({ where: toFilter(where) });
			},
			async update({ model: name, where, update }) {
				const delegate = model(name);
				const filter = toFilter(where);
				// better-auth's `update` changes one row: resolve it first, then write by key.
				const current = await delegate.findFirst({ where: filter, select: { id: true } });
				if (!current) return null;
				return (await delegate.update({ where: { id: current.id }, data: update as Row })) as never;
			},
			async updateMany({ model: name, where, update }) {
				return (await model(name).updateMany({ where: toFilter(where), data: update as Row })).count;
			},
			async delete({ model: name, where }) {
				await model(name).deleteMany({ where: toFilter(where) });
			},
			async deleteMany({ model: name, where }) {
				return (await model(name).deleteMany({ where: toFilter(where) })).count;
			}
		})
	});
}
