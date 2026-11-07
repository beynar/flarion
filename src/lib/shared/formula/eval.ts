/**
 * The evaluator, shared by the client (previews) and the server (on write). Pure: the only inputs are the
 * tree and the context (`prop` lookup and `now`), and it never throws: a failure comes back with the span of
 * the node that caused it. Empty values (`null`) read as 0, empty text, false or no date, by context.
 */
import { FormulaError, type FormulaNode } from './ast';
import { FUNCTIONS, RuntimeFailure, asBool, asNumber, asText, equalValues } from './functions';
import { formatValue, type FormulaValue } from './types';
import { compareText } from '../sort-keys';

export interface EvalContext {
	/** The value of property `name` of the page (null when empty or unknown). */
	prop(name: string): FormulaValue;
	/** Epoch ms of "now". */
	now: number;
}

export type EvalResult = { ok: true; value: FormulaValue } | { ok: false; error: FormulaError };

interface Scope {
	current: FormulaValue;
	index: number;
}

const MAX_LIST = 10_000;

function run(node: FormulaNode, ctx: EvalContext, scope: Scope | undefined): FormulaValue {
	try {
		return step(node, ctx, scope);
	} catch (e) {
		if (e instanceof RuntimeFailure) throw new FormulaError(e.message, node.start ?? 0, node.end ?? node.start ?? 0);
		throw e;
	}
}

function step(node: FormulaNode, ctx: EvalContext, scope: Scope | undefined): FormulaValue {
	const ev = (n: FormulaNode, s = scope): FormulaValue => run(n, ctx, s);
	switch (node.type) {
		case 'number':
		case 'string':
		case 'boolean':
			return node.value;
		case 'list':
			return node.items.map((n) => ev(n));
		case 'prop':
			return ctx.prop(node.name) ?? null;
		case 'ident':
			return scope ? (node.name === 'index' ? scope.index : scope.current) : null;
		case 'unary':
			return node.op === '-' ? -asNumber(ev(node.arg)) : !asBool(ev(node.arg));
		case 'binary': {
			if (node.op === 'and') return asBool(ev(node.left)) && asBool(ev(node.right));
			if (node.op === 'or') return asBool(ev(node.left)) || asBool(ev(node.right));
			const l = ev(node.left);
			const r = ev(node.right);
			switch (node.op) {
				case '+':
					if (typeof l === 'string' || typeof r === 'string') return formatValue(l) + formatValue(r);
					return asNumber(l) + asNumber(r);
				case '-':
					return asNumber(l) - asNumber(r);
				case '*':
					return asNumber(l) * asNumber(r);
				case '/':
					return asNumber(r) === 0 ? null : asNumber(l) / asNumber(r);
				case '%':
					return asNumber(r) === 0 ? null : asNumber(l) % asNumber(r);
				case '^':
					return asNumber(l) ** asNumber(r);
				case '==':
					return equalValues(l, r);
				case '!=':
					return !equalValues(l, r);
				default: {
					const c = compare(l, r);
					if (c === null) return false;
					return node.op === '<' ? c < 0 : node.op === '<=' ? c <= 0 : node.op === '>' ? c > 0 : c >= 0;
				}
			}
		}
		case 'call': {
			if (node.name === 'if') return asBool(ev(node.args[0])) ? ev(node.args[1]) : ev(node.args[2]);
			if (node.name === 'map' || node.name === 'filter') {
				const list = ev(node.args[0]);
				const items = list === null ? [] : Array.isArray(list) ? list : (() => { throw new RuntimeFailure('Expected a list'); })();
				if (items.length > MAX_LIST) throw new RuntimeFailure(`Lists of more than ${MAX_LIST} items are not supported`);
				const out: FormulaValue[] = [];
				items.forEach((item, index) => {
					const v = ev(node.args[1], { current: item, index });
					if (node.name === 'map') out.push(v);
					else if (asBool(v)) out.push(item);
				});
				return out;
			}
			const def = FUNCTIONS[node.name];
			if (!def) throw new RuntimeFailure(`Unknown function "${node.name}"`);
			if (node.args.length < def.min || node.args.length > def.max) throw new RuntimeFailure(`${node.name}() takes ${def.min === def.max ? def.min : `${def.min} to ${def.max}`} arguments`);
			const value = def.run(node.args.map((a) => ev(a)), { now: ctx.now });
			return typeof value === 'number' && !Number.isFinite(value) ? null : value;
		}
	}
}

/** Orders two values of the same kind: null when they cannot be ordered (an empty date, or mixed kinds). */
function compare(a: FormulaValue, b: FormulaValue): number | null {
	const x = a === null ? (typeof b === 'string' ? '' : typeof b === 'number' ? 0 : null) : a;
	const y = b === null ? (typeof a === 'string' ? '' : typeof a === 'number' ? 0 : null) : b;
	if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : x > y ? 1 : 0;
	if (typeof x === 'string' && typeof y === 'string') return compareText(x, y);
	if (x !== null && y !== null && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) return x.start < y.start ? -1 : x.start > y.start ? 1 : 0;
	return null;
}

/** Evaluates a parsed formula. Never throws. */
export function evaluateFormula(ast: FormulaNode, ctx: EvalContext): EvalResult {
	try {
		return { ok: true, value: run(ast, ctx, undefined) };
	} catch (e) {
		if (e instanceof FormulaError) return { ok: false, error: e };
		if (e instanceof RuntimeFailure) return { ok: false, error: new FormulaError(e.message, 0, 0) };
		if (e instanceof RangeError) return { ok: false, error: new FormulaError('This formula is nested too deeply to evaluate', 0, 0) };
		throw e;
	}
}

export { asText };
