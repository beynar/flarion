/**
 * The naive reference for everything the engine stores but does not take from a client write: relation values
 * (tombstoned targets dropped, the reverse side of a two-way relation), formulas and rollups. Every value is
 * recomputed from scratch from the base values of every page, by memoized recursion over the property graph, with
 * no dependency table, no reverse index and no incremental update: the oracle the incremental recompute is held to.
 *
 * It shares only the pure definitions of the language (`evaluateFormula`, `computeRollup`): what is tested is which
 * pages are recomputed and in what order, not what a function means.
 */
import {
	analyzeFormula,
	computeRollup,
	envFromProperties,
	evaluateFormula,
	fromPropValue,
	toPropValue,
	type FormulaNode,
	type FormulaValue,
	type RollupItem
} from '../../../src/lib/shared/formula';
import { formatValue } from '../../../src/lib/shared/formula';
import { isDateValue, normalizeValue, type PropValue, type PropertyDef, type PropertyRegistry } from '../../../src/lib/shared/property-types';

export interface NaivePage {
	id: string;
	num: number;
	title?: string;
	parentId?: string | null;
	createdAt: string;
	updatedAt: string | null;
	createdBy: string;
	updatedBy: string | null;
	deletedAt: string | null;
	props: Record<string, PropValue | null>;
}

export interface NaiveModel {
	registry: PropertyRegistry & { all(): PropertyDef[] };
	pages: readonly NaivePage[];
	now: number;
}

const list = (v: PropValue | null | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v !== '' ? [v] : []);
const optionName = (def: PropertyDef, id: string): string =>
	def.type === 'select' || def.type === 'multi_select' || def.type === 'status' ? (def.config.options.find((o) => o.id === id)?.name ?? id) : id;

/** Values of every page for every property, computed from scratch. Keyed by page id, then property id. */
export function naiveValues(m: NaiveModel): Map<string, Record<string, PropValue | null>> {
	const byId = new Map(m.pages.map((p) => [p.id, p]));
	const live = (id: string): NaivePage | undefined => {
		const p = byId.get(id);
		return p && !p.deletedAt ? p : undefined;
	};
	const defs = m.registry.all();
	const byName = new Map<string, PropertyDef>();
	for (const d of defs) if (!byName.has(d.name)) byName.set(d.name, d);
	const env = envFromProperties(defs);
	const analyses = new Map<string, FormulaNode | null>();
	const memo = new Map<string, PropValue | null>();

	const value = (p: NaivePage, def: PropertyDef): PropValue | null => {
		const key = `${p.id}|${def.id}`;
		if (memo.has(key)) return memo.get(key) as PropValue | null;
		const v = compute(p, def);
		memo.set(key, v);
		return v;
	};

	/** Pages related to `p` through a relation property (or its reverse side), live, by page number. */
	const related = (p: NaivePage, rel: PropertyDef): NaivePage[] => {
		if (rel.type !== 'relation') return [];
		if (rel.config.reverseOf)
			return m.pages.filter((h) => !h.deletedAt && list(h.props[rel.config.reverseOf as string]).includes(p.id)).sort((a, b) => a.num - b.num);
		return list(p.props[rel.id])
			.map(live)
			.filter((x): x is NaivePage => x !== undefined)
			.sort((a, b) => a.num - b.num);
	};

	const item = (def: PropertyDef, v: PropValue | null): RollupItem => {
		if (v === null) return { value: null, keys: [], texts: [] };
		if (def.type === 'select' || def.type === 'status' || def.type === 'multi_select') {
			const ids = list(v);
			return { value: v, keys: ids, texts: ids.map((id) => optionName(def, id)) };
		}
		if (Array.isArray(v)) return { value: v, keys: v, texts: v };
		if (typeof v === 'boolean') return { value: v, keys: [String(v)], texts: [v ? 'true' : 'false'] };
		if (typeof v === 'number') return { value: v, keys: [String(v)], texts: [formatValue(v)] };
		if (isDateValue(v)) return { value: v, keys: [`${v.start}|${v.end ?? ''}`], texts: [formatValue(fromPropValue(v, def))] };
		return { value: v, keys: [v], texts: [v] };
	};

	function compute(p: NaivePage, def: PropertyDef): PropValue | null {
		switch (def.type) {
			case 'title':
				return p.props.title ?? null;
			case 'created_time':
				return p.createdAt;
			case 'last_edited_time':
				return p.updatedAt ?? p.createdAt;
			case 'created_by':
				return p.createdBy;
			case 'last_edited_by':
				return p.updatedBy ?? p.createdBy;
			case 'relation': {
				const ids = def.config.reverseOf ? related(p, def).map((x) => x.id) : list(p.props[def.id]).filter((id) => live(id));
				// A relation left with no live target reads null.
				return ids.length ? ids : null;
			}
			case 'rollup': {
				const rel = m.registry.get(def.config.relationProp);
				const target = m.registry.get(def.config.targetProp);
				if (!rel || !target) return null;
				const items = related(p, rel).map((r) => item(target, value(r, target)));
				return normalizeValue(def, computeRollup(def.config.fn, items));
			}
			case 'formula': {
				if (!analyses.has(def.id)) {
					const a = analyzeFormula(def.config.expression, env);
					analyses.set(def.id, a.ok ? a.ast : null);
				}
				const ast = analyses.get(def.id);
				if (!ast) return null;
				const input = (name: string): FormulaValue => {
					const d = byName.get(name);
					if (!d) return null;
					const v = value(p, d);
					switch (d.type) {
						case 'select':
						case 'status':
							return typeof v === 'string' ? optionName(d, v) : null;
						case 'multi_select':
							return v === null ? null : list(v).map((id) => optionName(d, id));
						case 'relation': {
							// The titles of the live pages it points at (forward: in the order the user set).
							const ids = d.config.reverseOf ? related(p, d).map((x) => x.id) : list(p.props[d.id]);
							const titles = ids.map((id) => live(id)?.props.title).filter((t): t is string => typeof t === 'string' && t !== '');
							return titles.length ? titles : null;
						}
						default:
							return fromPropValue(v, d);
					}
				};
				const r = evaluateFormula(ast, { prop: input, now: m.now });
				return normalizeValue(def, r.ok ? toPropValue(def.config.resultType, r.value) : null);
			}
			default:
				return p.props[def.id] ?? null;
		}
	}

	const out = new Map<string, Record<string, PropValue | null>>();
	for (const p of m.pages) {
		const row: Record<string, PropValue | null> = {};
		for (const def of defs) {
			if (def.type === 'rollup' || def.type === 'formula' || def.type === 'relation') row[def.id] = value(p, def);
		}
		out.set(p.id, row);
	}
	return out;
}
