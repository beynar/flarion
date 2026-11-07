import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DAY_MS, formatDate } from '../../../src/lib/shared/dates';
import {
	CodecError,
	PROPERTY_TYPES,
	createRegistry,
	decodeValue,
	defaultConfig,
	defaultStatusConfig,
	encodeValue,
	filterOpsOf,
	formatUniqueId,
	isReadOnlyProperty,
	normalizeValue,
	parsePropertyConfig,
	propertyDefSchema,
	propertyTypes,
	sortKeyOf,
	storageTable,
	validateValue,
	valueClassOf,
	type CodecCtx,
	type PropValue,
	type PropertyDef,
	type PropertyType
} from '../../../src/lib/shared/property-types';
import { compareSortKeys, textSortKey } from '../../../src/lib/shared/sort-keys';
import { randomText, rng, type Rng } from './helpers';

const OPTIONS = [
	{ id: 'o1', name: 'Alpha', color: 'red' as const },
	{ id: 'o2', name: 'Beta', color: 'blue' as const },
	{ id: 'o3', name: 'Gamma', color: 'default' as const }
];
const pageNums = new Map([
	['pa', 1],
	['pb', 2],
	['pc', 3]
]);
const ctx: CodecCtx = {
	pageNum: (id) => pageNums.get(id),
	pageId: (n) => [...pageNums].find(([, x]) => x === n)?.[0]
};

function def(type: PropertyType, config?: unknown): PropertyDef {
	const parsed = v.parse(propertyDefSchema, { id: `p_${type}`, name: type, type, config });
	return parsed;
}

// Text made only of combining marks folds to an empty key; the codec keeps it (a row with v = ''),
// but it does not survive decode-then-encode, so the generator avoids it.
const text = (r: Rng, max: number, fallback = 'x') => {
	const t = randomText(r, max);
	return textSortKey(t) === '' ? fallback : t;
};

function randomValue(r: Rng, d: PropertyDef): PropValue | null {
	if (r.bool(0.1)) return null;
	switch (d.type) {
		case 'title':
		case 'text':
		case 'url':
		case 'phone':
		case 'ai':
			return text(r, 10);
		case 'email':
			return `${randomText(r, 5).replace(/[\s@]/g, '') || 'u'}@example.com`;
		case 'number':
			return r.bool() ? r.int(-1000, 1000) : (r.next() - 0.5) * 1e6;
		case 'unique_id':
			return r.int(0, 100000);
		case 'select':
		case 'status':
			return r.pick(d.config.options).id;
		case 'multi_select': {
			const picked = r.shuffle(d.config.options.map((o) => o.id)).slice(0, r.int(1, 3));
			return picked;
		}
		case 'checkbox':
			return r.bool();
		case 'person':
			return r.shuffle(['u1', 'u2', 'u3', 'u4']).slice(0, r.int(1, 3));
		case 'files':
			return r.shuffle(['f1', 'f2', 'f3']).slice(0, r.int(1, 3));
		case 'relation':
			return r.shuffle(['pa', 'pb', 'pc']).slice(0, r.int(1, 3));
		case 'date': {
			const dateOnly = !d.config.includeTime && r.bool();
			const a = r.int(0, 20000) * DAY_MS + (dateOnly ? 0 : r.int(1, DAY_MS - 1));
			const out: { start: string; end?: string } = { start: formatDate(a, dateOnly) };
			if (r.bool()) out.end = formatDate(a + r.int(0, 30) * DAY_MS + (dateOnly ? 0 : r.int(0, 1000)), dateOnly);
			return out;
		}
		case 'formula':
		case 'rollup':
			switch (d.config.resultType) {
				case 'text':
					return text(r, 6, 'y');
				case 'number':
					return r.int(-50, 50);
				case 'checkbox':
					return r.bool();
				case 'date':
					return { start: formatDate(r.int(0, 20000) * DAY_MS, true) };
			}
			return null;
		default:
			return null;
	}
}

const defs: PropertyDef[] = [
	def('title'),
	def('text'),
	def('url'),
	def('email'),
	def('phone'),
	def('number'),
	def('select', { options: OPTIONS }),
	def('status', defaultStatusConfig()),
	def('multi_select', { options: OPTIONS }),
	def('date'),
	def('date', { includeTime: true }),
	def('person'),
	def('checkbox'),
	def('files'),
	def('relation'),
	def('rollup', { relationProp: 'r', targetProp: 't', fn: 'sum', resultType: 'number' }),
	def('formula', { expression: '1+1', resultType: 'text' }),
	def('formula', { expression: 'now()', resultType: 'date' }),
	def('formula', { expression: 'true', resultType: 'checkbox' }),
	def('unique_id', { prefix: 'TASK' }),
	def('ai', { kind: 'summary' })
];

describe('registry', () => {
	it('covers every property type of the plan', () => {
		expect([...PROPERTY_TYPES].sort()).toEqual(Object.keys(propertyTypes).sort());
		expect(PROPERTY_TYPES).toHaveLength(22);
	});

	it('assigns the storage tables of the plan', () => {
		const tables = Object.fromEntries(
			defs.map((d) => [`${d.type}${d.type === 'formula' ? d.config.resultType : ''}`, storageTable(d)])
		);
		expect(tables).toMatchObject({
			title: 'p_text',
			text: 'p_text',
			url: 'p_text',
			email: 'p_text',
			phone: 'p_text',
			number: 'p_num',
			select: 'p_ref',
			status: 'p_ref',
			multi_select: 'p_ref',
			date: 'p_date',
			person: 'p_ref',
			checkbox: 'p_num',
			files: 'p_ref',
			relation: 'p_ref',
			rollup: 'p_num',
			formulatext: 'p_text',
			formuladate: 'p_date',
			formulacheckbox: 'p_num',
			unique_id: 'p_num',
			ai: 'p_text'
		});
		for (const t of ['created_time', 'created_by', 'last_edited_time', 'last_edited_by'] as const)
			expect(storageTable(def(t))).toBe('page');
	});

	it('lists the filter operators of the plan per type', () => {
		const ops = (d: PropertyDef) => Object.keys(filterOpsOf(d)).sort();
		expect(ops(def('title'))).toEqual(expect.arrayContaining(['contains', 'starts_with', 'is_empty']));
		expect(ops(def('number'))).toEqual(expect.arrayContaining(['eq', 'gt', 'gte', 'lt', 'lte', 'is_empty']));
		expect(ops(def('select', { options: [] }))).toEqual(['is', 'is_empty', 'is_not', 'is_not_empty']);
		expect(ops(def('multi_select', { options: [] }))).toEqual(['contains', 'is_empty', 'is_not_empty', 'not_contains']);
		expect(ops(def('date'))).toEqual(expect.arrayContaining(['is', 'before', 'after', 'within']));
		expect(ops(def('person'))).toEqual(expect.arrayContaining(['contains', 'is_me']));
		expect(ops(def('checkbox'))).toEqual(['is']);
		expect(ops(def('files'))).toEqual(['is_empty', 'is_not_empty']);
		expect(ops(def('relation'))).toEqual(expect.arrayContaining(['contains', 'is_empty']));
		expect(ops(def('unique_id'))).toEqual(['eq']);
		// computed types follow their result type
		expect(ops(def('formula', { expression: '1', resultType: 'number' }))).toContain('gt');
		expect(ops(def('formula', { expression: '1', resultType: 'date' }))).toContain('within');
		expect(ops(def('ai', { kind: 'summary' }))).toContain('contains');
		expect(valueClassOf(def('formula', { expression: '1', resultType: 'checkbox' }))).toBe('boolean');
	});

	it('marks computed and derived types read-only', () => {
		for (const t of ['rollup', 'formula', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'ai'] as const)
			expect(isReadOnlyProperty({ type: t }), t).toBe(true);
		for (const t of ['title', 'text', 'number', 'select', 'multi_select', 'date', 'person', 'checkbox', 'files', 'relation'] as const)
			expect(isReadOnlyProperty({ type: t }), t).toBe(false);
	});
});

describe('configs', () => {
	it('applies defaults', () => {
		expect(defaultConfig('number')).toEqual({ format: 'number' });
		expect(defaultConfig('select')).toEqual({ options: [] });
		expect(defaultConfig('date')).toEqual({ includeTime: false });
		expect(def('relation').config).toEqual({ limit: 'many' });
	});

	it('rejects bad configs', () => {
		expect(parsePropertyConfig('rollup', { fn: 'sum' }).ok).toBe(false);
		expect(parsePropertyConfig('unique_id', { prefix: 'bad prefix!' }).ok).toBe(false);
		expect(parsePropertyConfig('number', { precision: 11 }).ok).toBe(false);
		const dup = parsePropertyConfig('select', { options: [OPTIONS[0], OPTIONS[0]] });
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.issues[0].code).toBe('duplicate_option');
		const grp = parsePropertyConfig('status', { options: [OPTIONS[0]], groups: [{ id: 'g', name: 'G', optionIds: ['nope'] }] });
		expect(grp.ok).toBe(false);
		expect(parsePropertyConfig('status', defaultStatusConfig()).ok).toBe(true);
	});

	it('discriminates property definitions by type', () => {
		expect(v.safeParse(propertyDefSchema, { id: 'a', name: 'A', type: 'nope', config: {} }).success).toBe(false);
		expect(v.safeParse(propertyDefSchema, { id: '$parent', name: 'A', type: 'text' }).success).toBe(false);
		expect(v.safeParse(propertyDefSchema, { id: 'a', name: 'A', type: 'rollup' }).success).toBe(false);
		expect(formatUniqueId('TASK', 7)).toBe('TASK-7');
		expect(formatUniqueId(undefined, 7)).toBe('7');
	});
});

describe('codecs', () => {
	it('round-trips random values for every type', () => {
		const r = rng(42);
		for (const d of defs) {
			const lossy = propertyTypes[d.type].lossy && valueClassOf(d) === 'text';
			for (let i = 0; i < 200; i++) {
				const value = randomValue(r, d);
				const rows = encodeValue(d, value, ctx);
				const back = decodeValue(d, rows, ctx);
				if (value === null) {
					expect(rows, d.type).toEqual([]);
					expect(back).toBeNull();
					continue;
				}
				const expected = lossy ? textSortKey(value as string) : normalizeValue(d, value);
				if (Array.isArray(expected) && !(d.type === 'multi_select')) {
					expect(new Set(back as string[]), d.type).toEqual(new Set(expected));
				} else if (d.type === 'multi_select') {
					const order = new Map(OPTIONS.map((o, k) => [o.id, k]));
					expect(back).toEqual([...(expected as string[])].sort((a, b) => order.get(a)! - order.get(b)!));
				} else {
					expect(back, `${d.type}: ${JSON.stringify(value)}`).toEqual(expected);
				}
				// decode is a fixed point of encode: re-encoding gives the same set of rows
				const byV = (a: { v: string | number }, b: { v: string | number }) => (String(a.v) < String(b.v) ? -1 : 1);
				expect([...encodeValue(d, back, ctx)].sort(byV)).toEqual([...rows].sort(byV));
			}
		}
	});

	it('multi-select becomes one row per option, storing option ids', () => {
		const d = def('multi_select', { options: OPTIONS });
		expect(encodeValue(d, ['o2', 'o1', 'o2'])).toEqual([
			{ table: 'p_ref', v: 'o2' },
			{ table: 'p_ref', v: 'o1' }
		]);
		expect(decodeValue(d, [{ table: 'p_ref', v: 'o3' }, { table: 'p_ref', v: 'o1' }])).toEqual(['o1', 'o3']);
		expect(encodeValue(def('select', { options: OPTIONS }), 'o2')).toEqual([{ table: 'p_ref', v: 'o2' }]);
	});

	it('stores text as folded keys, numbers as numbers, dates as epoch ms', () => {
		expect(encodeValue(def('title'), 'Éclair Café')).toEqual([{ table: 'p_text', v: 'eclair cafe' }]);
		expect(encodeValue(def('number'), -0)).toEqual([{ table: 'p_num', v: 0 }]);
		expect(encodeValue(def('number'), 12.5)).toEqual([{ table: 'p_num', v: 12.5 }]);
		expect(encodeValue(def('date'), { start: '2026-11-07' })).toEqual([{ table: 'p_date', v: Date.UTC(2026, 10, 7) }]);
		expect(encodeValue(def('date'), { start: '2026-11-07', end: '2026-11-09' })).toEqual([
			{ table: 'p_date', v: Date.UTC(2026, 10, 7), v_end: Date.UTC(2026, 10, 9) }
		]);
		expect(encodeValue(def('checkbox'), true)).toEqual([{ table: 'p_num', v: 1 }]);
		expect(encodeValue(def('checkbox'), false)).toEqual([{ table: 'p_num', v: 0 }]);
		expect(decodeValue(def('checkbox'), [])).toBeNull();
	});

	it('marks computed rows and stores relations by page number', () => {
		expect(encodeValue(def('formula', { expression: '', resultType: 'number' }), 3)).toEqual([
			{ table: 'p_num', v: 3, computed: true }
		]);
		expect(encodeValue(def('ai', { kind: 'summary' }), 'Résumé')).toEqual([{ table: 'p_text', v: 'resume', computed: true }]);
		expect(encodeValue(def('relation'), ['pb', 'pa'], ctx)).toEqual([
			{ table: 'p_ref', v: 2 },
			{ table: 'p_ref', v: 1 }
		]);
		expect(() => encodeValue(def('relation'), ['unknown'], ctx)).toThrow(CodecError);
		expect(() => encodeValue(def('relation'), ['pa'])).toThrow(CodecError);
		expect(encodeValue(def('created_by'), 'u1')).toEqual([]);
	});

	it('refuses values of the wrong shape', () => {
		expect(() => encodeValue(def('number'), 'x')).toThrow(CodecError);
		expect(() => encodeValue(def('number'), NaN)).toThrow(RangeError);
		expect(() => encodeValue(def('checkbox'), 'yes')).toThrow(CodecError);
		expect(() => encodeValue(def('date'), { start: 'nope' })).toThrow(CodecError);
		expect(() => encodeValue(def('date'), { start: '2026-11-09', end: '2026-11-07' })).toThrow(CodecError);
		expect(() => encodeValue(def('title'), 5)).toThrow(CodecError);
	});

	it('decodes a midnight datetime as date-only unless includeTime is set', () => {
		const rows = encodeValue(def('date'), { start: '2026-11-07T00:00:00Z' });
		expect(decodeValue(def('date'), rows)).toEqual({ start: '2026-11-07' });
		expect(decodeValue(def('date', { includeTime: true }), rows)).toEqual({ start: '2026-11-07T00:00:00Z' });
	});

	it('writes real SQLite rows that sort as the sort keys do', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(`
			CREATE TABLE p_text(prop TEXT, v TEXT, page TEXT, PRIMARY KEY (prop, v, page)) WITHOUT ROWID;
			CREATE TABLE p_num(prop TEXT, v NUMERIC, page TEXT, PRIMARY KEY (prop, v, page)) WITHOUT ROWID;
			CREATE TABLE p_date(prop TEXT, v INTEGER, v_end INTEGER, page TEXT, PRIMARY KEY (prop, v, page)) WITHOUT ROWID;
			CREATE TABLE p_ref(prop TEXT, v, page TEXT, PRIMARY KEY (prop, v, page)) WITHOUT ROWID;
		`);
		const r = rng(8);
		const title = def('title');
		const count = def('number');
		const when = def('date');
		const titles: { page: string; value: string }[] = [];
		const nums: { page: string; value: number }[] = [];
		for (let i = 0; i < 300; i++) {
			const page = `pg${String(i).padStart(4, '0')}`;
			const t = randomText(r, 8) || 'z';
			const n = r.bool() ? r.int(-50, 50) : r.next() * 100;
			titles.push({ page, value: t });
			nums.push({ page, value: n });
			for (const row of encodeValue(title, t)) db.prepare('INSERT INTO p_text VALUES (?,?,?)').run('t', row.v as string, page);
			for (const row of encodeValue(count, n)) db.prepare('INSERT INTO p_num VALUES (?,?,?)').run('n', row.v as number, page);
			for (const row of encodeValue(when, { start: formatDate(r.int(0, 9999) * DAY_MS, true) }))
				db.prepare('INSERT INTO p_date VALUES (?,?,?,?)').run('d', row.v as number, row.v_end ?? null, page);
		}
		const byIndexText = (db.prepare("SELECT page FROM p_text WHERE prop='t' ORDER BY v, page").all() as { page: string }[]).map((x) => x.page);
		const byMemoryText = [...titles]
			.sort((a, b) => compareSortKeys(sortKeyOf(title, a.value)!, sortKeyOf(title, b.value)!) || (a.page < b.page ? -1 : 1))
			.map((x) => x.page);
		expect(byIndexText).toEqual(byMemoryText);
		const byIndexNum = (db.prepare("SELECT page FROM p_num WHERE prop='n' ORDER BY v, page").all() as { page: string }[]).map((x) => x.page);
		const byMemoryNum = [...nums].sort((a, b) => a.value - b.value || (a.page < b.page ? -1 : 1)).map((x) => x.page);
		expect(byIndexNum).toEqual(byMemoryNum);
		db.close();
	});
});

describe('values', () => {
	it('validates against the config', () => {
		const sel = def('select', { options: OPTIONS });
		expect(validateValue(sel, 'o1').ok).toBe(true);
		expect(validateValue(sel, 'zzz').ok).toBe(false);
		expect(validateValue(def('multi_select', { options: OPTIONS }), ['o1', 'o1']).ok).toBe(false);
		expect(validateValue(def('multi_select', { options: OPTIONS }), ['o1', 'nope']).ok).toBe(false);
		expect(validateValue(def('number'), 'abc').ok).toBe(false);
		expect(validateValue(def('email'), 'not an email').ok).toBe(false);
		expect(validateValue(def('email'), 'a@b.co').ok).toBe(true);
		expect(validateValue(def('date'), { start: '2026-11-07', end: '2026-01-01' }).ok).toBe(false);
		expect(validateValue(def('checkbox'), 1).ok).toBe(false);
		expect(validateValue(def('text'), '').ok).toBe(true);
	});

	it('normalizes empties, duplicates, dates and negative zero', () => {
		const m = def('multi_select', { options: OPTIONS });
		expect(normalizeValue(m, [])).toBeNull();
		expect(normalizeValue(m, ['o1', 'o2', 'o1'])).toEqual(['o1', 'o2']);
		expect(normalizeValue(def('text'), '')).toBeNull();
		expect(normalizeValue(def('date'), { start: '2026-11-07T12:00:00+02:00', end: null })).toEqual({ start: '2026-11-07T10:00:00Z' });
		expect(Object.is(normalizeValue(def('number'), -0), 0)).toBe(true);
		expect(normalizeValue(def('checkbox'), false)).toBe(false);
	});

	it('sorts select-like values by option order and dates by start', () => {
		const sel = def('select', { options: OPTIONS });
		expect(sortKeyOf(sel, 'o3')).toBe(2);
		expect(sortKeyOf(sel, 'o1')).toBe(0);
		expect(sortKeyOf(sel, null)).toBeNull();
		expect(sortKeyOf(def('multi_select', { options: OPTIONS }), ['o3', 'o2'])).toBe(1);
		expect(sortKeyOf(def('date'), { start: '2026-11-07' })).toBe(Date.UTC(2026, 10, 7));
		expect(sortKeyOf(def('person'), ['u1'])).toBeNull();
		expect(sortKeyOf(def('checkbox'), true)).toBe(1);
		expect(sortKeyOf(def('title'), 'Zed')).toBe('zed');
	});

	it('builds a registry', () => {
		const reg = createRegistry([def('title'), def('number')]);
		expect(reg.get('p_title')?.type).toBe('title');
		expect(reg.get('missing')).toBeUndefined();
		expect(reg.all()).toHaveLength(2);
	});
});
