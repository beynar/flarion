import { describe, expect, test } from 'vitest';
import {
	FUNCTION_NAMES,
	formatError,
	parseFormula,
	printFormula,
	stripSpans,
	type FormulaNode
} from '../../../src/lib/shared/formula';
import { rng, type Rng } from '../shared/helpers';

const parse = (src: string): FormulaNode => {
	const r = parseFormula(src);
	if (!r.ok) throw new Error(formatError(src, r.error));
	return stripSpans(r.ast);
};
const num = (value: number): FormulaNode => ({ type: 'number', value });
const bin = (op: string, left: FormulaNode, right: FormulaNode): FormulaNode => ({ type: 'binary', op, left, right }) as FormulaNode;

describe('parsing', () => {
	test('literals and references', () => {
		expect(parse('12')).toEqual(num(12));
		expect(parse('3.5e2')).toEqual(num(350));
		expect(parse('.5')).toEqual(num(0.5));
		expect(parse('"a\\"b\\n"')).toEqual({ type: 'string', value: 'a"b\n' });
		expect(parse('true')).toEqual({ type: 'boolean', value: true });
		expect(parse('prop("Due date")')).toEqual({ type: 'prop', name: 'Due date' });
		expect(parse('[1, 2]')).toEqual({ type: 'list', items: [num(1), num(2)] });
		expect(parse('current')).toEqual({ type: 'ident', name: 'current' });
	});

	test('precedence and associativity', () => {
		expect(parse('1 + 2 * 3')).toEqual(bin('+', num(1), bin('*', num(2), num(3))));
		expect(parse('1 - 2 - 3')).toEqual(bin('-', bin('-', num(1), num(2)), num(3)));
		expect(parse('2 ^ 3 ^ 2')).toEqual(bin('^', num(2), bin('^', num(3), num(2))));
		expect(parse('-2 ^ 2')).toEqual({ type: 'unary', op: '-', arg: bin('^', num(2), num(2)) });
		expect(parse('2 ^ -1')).toEqual(bin('^', num(2), { type: 'unary', op: '-', arg: num(1) }));
		expect(parse('1 < 2 == true')).toEqual(bin('==', bin('<', num(1), num(2)), { type: 'boolean', value: true }));
		expect(parse('true or false and false')).toEqual(bin('or', { type: 'boolean', value: true }, bin('and', { type: 'boolean', value: false }, { type: 'boolean', value: false })));
		expect(parse('(1 + 2) * 3')).toEqual(bin('*', bin('+', num(1), num(2)), num(3)));
	});

	test('operator spellings normalize: && || ! and keyword forms, ternary is if()', () => {
		expect(parse('true && false || !true')).toEqual(parse('true and false or not true'));
		expect(parse('1 > 0 ? "y" : "n"')).toEqual(parse('if(1 > 0, "y", "n")'));
		expect(parse('a ? b : c' .replace(/[abc]/g, (c) => ({ a: 'true', b: '1', c: '2' })[c]!))).toEqual(parse('if(true, 1, 2)'));
		expect(parse('IF(true, 1, 2)')).toEqual(parse('if(true, 1, 2)'));
	});

	test('errors carry positions and a readable message', () => {
		const cases: [string, string, number, number][] = [
			['1 +', 'Expected a value, found the end of the formula', 3, 4],
			['(1 + 2', 'Expected ")" to close the parenthesis, found the end of the formula', 6, 7],
			['1 $ 2', 'Unexpected character "$"', 2, 3],
			['"abc', 'This text is missing its closing quote', 0, 4],
			['foo', 'Unknown name "foo". Properties are written prop("foo")', 0, 3],
			['prop(1)', 'prop() takes one property name in quotes, as in prop("Name")', 0, 7],
			['1 2', 'Unexpected "2"', 2, 3],
			['', 'The formula is empty', 0, 0],
			['3x', 'Unexpected "x" after the number 3', 1, 2],
			['"a\\q"', 'Unknown escape "\\q" (use \\", \\\\, \\n, \\t or \\r)', 2, 4],
			['true ? 1', 'Expected ":" between the two outcomes of "?", found the end of the formula', 8, 9]
		];
		for (const [src, message, start, end] of cases) {
			const r = parseFormula(src);
			expect(r.ok, src).toBe(false);
			if (!r.ok) expect([r.error.message, r.error.start, r.error.end], src).toEqual([message, start, end]);
		}
		const r = parseFormula('1 +\n  * 2');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(formatError('1 +\n  * 2', r.error)).toBe('Unexpected "*" (line 2, column 3)\n  * 2\n  ^');
	});

	test('nesting is bounded and long formulas are refused', () => {
		const r = parseFormula('('.repeat(500) + '1' + ')'.repeat(500));
		expect(r.ok).toBe(false);
		expect(parseFormula('1+'.repeat(6000) + '1').ok).toBe(false);
		// A long flat expression is fine.
		expect(parseFormula(Array.from({ length: 1500 }, () => '1').join(' + ')).ok).toBe(true);
	});

	test('spans point at the source', () => {
		const r = parseFormula('1 + foo(2)');
		expect(r.ok).toBe(true);
		if (r.ok && r.ast.type === 'binary') {
			expect([r.ast.start, r.ast.end]).toEqual([0, 10]);
			expect([r.ast.right.start, r.ast.right.end]).toEqual([4, 10]);
		}
	});
});

// ───────────────────────────── round trip, as a property ─────────────────────────────

const NAMES = FUNCTION_NAMES.filter((n) => n !== 'prop');
const OPS = ['+', '-', '*', '/', '%', '^', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'] as const;
const STRINGS = ['', 'a', 'say "hi"', 'back\\slash', 'line\nbreak', 'tab\t', 'é日本😀', 'prop(', ' '];

function randomAst(r: Rng, depth: number): FormulaNode {
	const leaf = depth <= 0 || r.bool(0.25);
	if (leaf) {
		switch (r.int(0, 5)) {
			case 0:
				return num(r.pick([0, 1, 2.5, 100, 1e21, 1e-7, 123456789.125, 0.1]));
			case 1:
				return { type: 'string', value: r.pick(STRINGS) };
			case 2:
				return { type: 'boolean', value: r.bool() };
			case 3:
				return { type: 'prop', name: r.pick(['Name', 'Due date', 'a "b"', 'é']) };
			case 4:
				return { type: 'ident', name: r.pick(['current', 'index']) };
			default:
				return { type: 'list', items: Array.from({ length: r.int(0, 3) }, () => randomAst(r, depth - 2)) };
		}
	}
	switch (r.int(0, 3)) {
		case 0:
			return { type: 'unary', op: r.pick(['-', 'not'] as const), arg: randomAst(r, depth - 1) };
		case 1:
		case 2:
			return bin(r.pick(OPS), randomAst(r, depth - 1), randomAst(r, depth - 1));
		default:
			return { type: 'call', name: r.pick(NAMES), args: Array.from({ length: r.int(0, 3) }, () => randomAst(r, depth - 1)) };
	}
}

describe('print and parse round trip', () => {
	test('parse(print(ast)) is ast for 3000 random trees', () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const r = rng(seed);
			const ast = randomAst(r, r.int(1, 7));
			const text = printFormula(ast);
			const back = parseFormula(text);
			if (!back.ok) throw new Error(`seed ${seed}: ${text}\n${formatError(text, back.error)}`);
			expect(stripSpans(back.ast), `seed ${seed}: ${text}`).toEqual(stripSpans(ast));
			// Printing is a fixed point.
			expect(printFormula(back.ast)).toBe(text);
		}
	});

	test('printing adds only the parentheses it needs', () => {
		const p = (s: string) => printFormula(parse(s));
		expect(p('(1 + 2) + 3')).toBe('1 + 2 + 3');
		expect(p('1 + (2 + 3)')).toBe('1 + (2 + 3)');
		expect(p('(2 ^ 3) ^ 2')).toBe('(2 ^ 3) ^ 2');
		expect(p('2 ^ (3 ^ 2)')).toBe('2 ^ 3 ^ 2');
		expect(p('-(1 + 2)')).toBe('-(1 + 2)');
		expect(p('(-2) ^ 2')).toBe('(-2) ^ 2');
		expect(p('not (a == b)'.replace(/[ab]/g, '1'))).toBe('not (1 == 1)');
		expect(p('true ? 1 : 2')).toBe('if(true, 1, 2)');
		expect(p('a'.replace('a', 'prop("x")') + ' && true')).toBe('prop("x") and true');
	});

	test('random garbage never throws, only errors', () => {
		const chars = '()[]"\\ +-*/%^<>=!&|?:,.0123456789abc_éxyz\n';
		for (let seed = 1; seed <= 1500; seed++) {
			const r = rng(seed + 90000);
			const src = Array.from({ length: r.int(0, 24) }, () => r.pick([...chars])).join('');
			const res = parseFormula(src);
			if (!res.ok) {
				expect(res.error.start).toBeGreaterThanOrEqual(0);
				expect(res.error.end).toBeGreaterThanOrEqual(res.error.start);
				expect(res.error.end).toBeLessThanOrEqual(src.length + 1);
			}
		}
	});
});
