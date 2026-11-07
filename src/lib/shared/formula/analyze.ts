/**
 * Static analysis: types (which pick the storage table), the properties a formula reads, and whether it
 * reads the clock. Readable errors with positions: every problem is collected, not just the first.
 */
import { FormulaError, walk, type FormulaNode } from './ast';
import { FUNCTIONS, SPECIAL_FORMS } from './functions';
import { parseFormula } from './parser';
import { fits, isList, resultTypeOf, typeName, unify, type FType, type PropTypeEnv } from './types';
import type { ComputedResultType } from '../property-types';

interface Scope {
	current: FType;
}

const span = (n: FormulaNode): [number, number] => [n.start ?? 0, n.end ?? n.start ?? 0];

/** Infers the type of an expression, appending problems to `errors`. `any` stands for "unknown, keep going". */
export function inferType(node: FormulaNode, env: PropTypeEnv | undefined, errors: FormulaError[], scope?: Scope): FType {
	const err = (n: FormulaNode, message: string): FType => {
		errors.push(new FormulaError(message, ...span(n)));
		return 'any';
	};
	const infer = (n: FormulaNode, s = scope): FType => inferType(n, env, errors, s);
	switch (node.type) {
		case 'number':
			return 'number';
		case 'string':
			return 'text';
		case 'boolean':
			return 'checkbox';
		case 'list': {
			let item: FType = 'any';
			for (const it of node.items) {
				const t = infer(it);
				const u = unify(item, t);
				if (u === null) err(it, `List items must share one type, found ${typeName(item)} and ${typeName(t)}`);
				else item = u;
			}
			return { list: item };
		}
		case 'prop': {
			if (!env) return 'any';
			const t = env(node.name);
			return t ?? err(node, `Unknown property "${node.name}"`);
		}
		case 'ident':
			return scope ? (node.name === 'index' ? 'number' : scope.current) : err(node, `"${node.name}" is only available inside map() and filter()`);
		case 'unary': {
			const t = infer(node.arg);
			const want: FType = node.op === '-' ? 'number' : 'checkbox';
			if (!fits(t, want)) err(node.arg, `"${node.op}" needs ${typeName(want)}, got ${typeName(t)}`);
			return want;
		}
		case 'binary': {
			const l = infer(node.left);
			const r = infer(node.right);
			switch (node.op) {
				case '+':
					if (l === 'text' || r === 'text') return 'text';
					if (l === 'any' || r === 'any') return 'any';
					if (l === 'number' && r === 'number') return 'number';
					return err(node, `Cannot add ${typeName(l)} and ${typeName(r)} (use dateAdd for dates)`);
				case '-':
				case '*':
				case '/':
				case '%':
				case '^':
					if (!fits(l, 'number')) err(node.left, `"${node.op}" needs numbers, got ${typeName(l)}`);
					if (!fits(r, 'number')) err(node.right, `"${node.op}" needs numbers, got ${typeName(r)}`);
					return 'number';
				case '==':
				case '!=':
					if (unify(l, r) === null) err(node, `Cannot compare ${typeName(l)} with ${typeName(r)}`);
					return 'checkbox';
				case '<':
				case '<=':
				case '>':
				case '>=': {
					const u = unify(l, r);
					if (u === null) err(node, `Cannot compare ${typeName(l)} with ${typeName(r)}`);
					else if (isList(u) || u === 'checkbox') err(node, `"${node.op}" compares numbers, text or dates, not ${typeName(u)}`);
					return 'checkbox';
				}
				case 'and':
				case 'or':
					if (!fits(l, 'checkbox')) err(node.left, `"${node.op}" needs checkboxes, got ${typeName(l)}`);
					if (!fits(r, 'checkbox')) err(node.right, `"${node.op}" needs checkboxes, got ${typeName(r)}`);
					return 'checkbox';
			}
			return 'any';
		}
		case 'call':
			return inferCall(node, infer, err, scope);
	}
}

function inferCall(
	node: Extract<FormulaNode, { type: 'call' }>,
	infer: (n: FormulaNode, s?: Scope) => FType,
	err: (n: FormulaNode, message: string) => FType,
	scope: Scope | undefined
): FType {
	const { name, args } = node;
	const arity = (min: number, max: number): boolean => {
		if (args.length >= min && args.length <= max) return true;
		const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
		err(node, `${name}() takes ${want} argument${max === 1 ? '' : 's'}, got ${args.length}`);
		args.forEach((a) => infer(a));
		return false;
	};
	if (name === 'if') {
		if (!arity(3, 3)) return 'any';
		const c = infer(args[0]);
		if (!fits(c, 'checkbox')) err(args[0], `The condition of if() must be a checkbox, got ${typeName(c)}`);
		const a = infer(args[1]);
		const b = infer(args[2]);
		const u = unify(a, b);
		return u ?? err(node, `The two outcomes of if() must have the same type, got ${typeName(a)} and ${typeName(b)}`);
	}
	if (name === 'map' || name === 'filter') {
		if (!arity(2, 2)) return 'any';
		const l = infer(args[0]);
		let item: FType = 'any';
		if (isList(l)) item = l.list;
		else if (l !== 'any') err(args[0], `${name}() needs a list, got ${typeName(l)}`);
		const body = infer(args[1], { current: item });
		if (name === 'filter') {
			if (!fits(body, 'checkbox')) err(args[1], `The test of filter() must be a checkbox, got ${typeName(body)}`);
			return { list: item };
		}
		return { list: body };
	}
	const def = FUNCTIONS[name];
	if (!def) return (args.forEach((a) => infer(a)), err(node, `Unknown function "${name}"`));
	if (!arity(def.min, def.max)) return 'any';
	const types = args.map((a) => infer(a, scope));
	return def.type(types, (i, message) => void err(args[i] ?? node, message));
}

/** The names of the properties a formula reads (`prop("Name")`), in order of first use. */
export function extractDeps(ast: FormulaNode): string[] {
	const out = new Set<string>();
	walk(ast, (n) => {
		if (n.type === 'prop') out.add(n.name);
	});
	return [...out];
}

/** Whether the formula reads the clock (`now()` or `today()`): such formulas are recomputed hourly. */
export function readsNow(ast: FormulaNode): boolean {
	let found = false;
	walk(ast, (n) => {
		if (n.type === 'call' && (n.name === 'now' || n.name === 'today')) found = true;
	});
	return found;
}

export interface FormulaAnalysis {
	ast: FormulaNode;
	/** The expression's type. */
	type: FType;
	/** The property result type (storage table) it maps to. */
	resultType: ComputedResultType;
	/** Property names read. */
	deps: string[];
	/** Reads `now()` or `today()`. */
	usesNow: boolean;
}

export type AnalyzeResult = ({ ok: true } & FormulaAnalysis) | { ok: false; errors: FormulaError[] };

/** Parses and type-checks a formula against the properties it can read. */
export function analyzeFormula(source: string, env?: PropTypeEnv): AnalyzeResult {
	const parsed = parseFormula(source);
	if (!parsed.ok) return { ok: false, errors: [parsed.error] };
	const errors: FormulaError[] = [];
	const type = inferType(parsed.ast, env, errors);
	if (errors.length) return { ok: false, errors };
	return { ok: true, ast: parsed.ast, type, resultType: resultTypeOf(type), deps: extractDeps(parsed.ast), usesNow: readsNow(parsed.ast) };
}

export { SPECIAL_FORMS };
