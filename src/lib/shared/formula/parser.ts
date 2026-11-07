/**
 * Lexer and parser of the formula language: a Notion-like expression syntax.
 *
 *   expression := ternary
 *   ternary    := or ('?' ternary ':' ternary)?          -- the same node as if(c, a, b)
 *   or         := and (('or' | '||') and)*
 *   and        := equality (('and' | '&&') equality)*
 *   equality   := compare (('==' | '!=') compare)*
 *   compare    := sum (('<' | '<=' | '>' | '>=') sum)*
 *   sum        := product (('+' | '-') product)*
 *   product    := unary (('*' | '/' | '%') unary)*
 *   unary      := ('-' | 'not' | '!') unary | power
 *   power      := postfix ('^' unary)?                    -- right-associative
 *   postfix    := primary | name '(' args ')'
 *   primary    := number | "string" | true | false | '[' items ']' | '(' expression ')' | name
 *
 * `prop("Name")` is the property reference. Names are case-insensitive for functions (`IF`, `if`), kept
 * lower-case in the tree. Errors carry the span of the offending source.
 */
import { FormulaError, type BinaryOp, type FormulaNode } from './ast';

export const MAX_FORMULA_LENGTH = 10_000;
const MAX_DEPTH = 100;

type TokenType = 'number' | 'string' | 'name' | 'op' | 'eof';
interface Token {
	type: TokenType;
	text: string;
	value?: number | string;
	start: number;
	end: number;
}

const KEYWORD_OPS: Readonly<Record<string, string>> = { and: 'and', or: 'or', not: 'not' };
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':', '(', ')', '[', ']', ','];

function lex(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const start = i;
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i)) as RegExpExecArray;
			i += m[0].length;
			if (/[A-Za-z_]/.test(src[i] ?? '')) throw new FormulaError(`Unexpected "${src[i]}" after the number ${m[0]}`, i, i + 1);
			const value = Number(m[0]);
			if (!Number.isFinite(value)) throw new FormulaError(`The number ${m[0]} is too large`, start, i);
			out.push({ type: 'number', text: m[0], value, start, end: i });
			continue;
		}
		if (c === '"') {
			let s = '';
			i++;
			for (;;) {
				if (i >= src.length) throw new FormulaError('This text is missing its closing quote', start, src.length);
				const ch = src[i];
				if (ch === '"') {
					i++;
					break;
				}
				if (ch === '\\') {
					const next = src[i + 1];
					const esc: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r' };
					if (next === undefined || !(next in esc)) throw new FormulaError(`Unknown escape "\\${next ?? ''}" (use \\", \\\\, \\n, \\t or \\r)`, i, i + 2);
					s += esc[next];
					i += 2;
					continue;
				}
				s += ch;
				i++;
			}
			out.push({ type: 'string', text: src.slice(start, i), value: s, start, end: i });
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
			i += m[0].length;
			const lower = m[0].toLowerCase();
			out.push(lower in KEYWORD_OPS ? { type: 'op', text: KEYWORD_OPS[lower], start, end: i } : { type: 'name', text: m[0], start, end: i });
			continue;
		}
		const op = OPERATORS.find((o) => src.startsWith(o, i));
		if (!op) throw new FormulaError(`Unexpected character "${c}"`, i, i + 1);
		i += op.length;
		out.push({ type: 'op', text: op, start, end: i });
	}
	out.push({ type: 'eof', text: '', start: src.length, end: src.length });
	return out;
}

class Parser {
	#i = 0;
	#depth = 0;
	constructor(
		readonly tokens: Token[],
		readonly src: string
	) {}

	get #tok(): Token {
		return this.tokens[this.#i];
	}

	#describe(t: Token): string {
		return t.type === 'eof' ? 'the end of the formula' : `"${t.text}"`;
	}

	#atEnd(): boolean {
		return this.tokens[this.#i].type === 'eof';
	}

	#isOp(text: string): boolean {
		return this.#tok.type === 'op' && this.#tok.text === text;
	}

	#eat(text: string): Token | null {
		if (!this.#isOp(text)) return null;
		return this.tokens[this.#i++];
	}

	#expect(text: string, why: string): Token {
		const t = this.#eat(text);
		if (!t) throw new FormulaError(`Expected "${text}" ${why}, found ${this.#describe(this.#tok)}`, this.#tok.start, Math.max(this.#tok.end, this.#tok.start + 1));
		return t;
	}

	parse(): FormulaNode {
		if (this.#atEnd()) throw new FormulaError('The formula is empty', 0, 0);
		const node = this.#ternary();
		if (!this.#atEnd()) throw new FormulaError(`Unexpected ${this.#describe(this.#tok)}`, this.#tok.start, this.#tok.end);
		return node;
	}

	#nest<T>(fn: () => T): T {
		if (++this.#depth > MAX_DEPTH) throw new FormulaError('This formula is nested too deeply', this.#tok.start, this.#tok.end);
		try {
			return fn();
		} finally {
			this.#depth--;
		}
	}

	#ternary(): FormulaNode {
		return this.#nest(() => {
			const cond = this.#binary(1);
			if (!this.#eat('?')) return cond;
			const a = this.#ternary();
			this.#expect(':', 'between the two outcomes of "?"');
			const b = this.#ternary();
			return { type: 'call', name: 'if', args: [cond, a, b], start: cond.start, end: b.end };
		});
	}

	#binaryOp(level: number): BinaryOp | null {
		const t = this.#tok;
		if (t.type !== 'op') return null;
		const text = t.text === '&&' ? 'and' : t.text === '||' ? 'or' : t.text;
		const levels: Record<number, string[]> = { 1: ['or'], 2: ['and'], 3: ['==', '!='], 4: ['<', '<=', '>', '>='], 5: ['+', '-'], 6: ['*', '/', '%'] };
		return levels[level]?.includes(text) ? (text as BinaryOp) : null;
	}

	#binary(level: number): FormulaNode {
		if (level > 6) return this.#unary();
		let left = this.#binary(level + 1);
		for (let op = this.#binaryOp(level); op; op = this.#binaryOp(level)) {
			this.#i++;
			const right = this.#binary(level + 1);
			left = { type: 'binary', op, left, right, start: left.start, end: right.end };
		}
		return left;
	}

	#unary(): FormulaNode {
		return this.#nest(() => {
			const t = this.#tok;
			if (t.type === 'op' && (t.text === '-' || t.text === 'not' || t.text === '!')) {
				this.#i++;
				const arg = this.#unary();
				return { type: 'unary', op: t.text === '-' ? '-' : 'not', arg, start: t.start, end: arg.end };
			}
			return this.#power();
		});
	}

	#power(): FormulaNode {
		const base = this.#postfix();
		if (!this.#eat('^')) return base;
		const exp = this.#unary();
		return { type: 'binary', op: '^', left: base, right: exp, start: base.start, end: exp.end };
	}

	#postfix(): FormulaNode {
		const t = this.#tok;
		if (t.type === 'name') {
			this.#i++;
			if (this.#isOp('(')) return this.#call(t);
			const lower = t.text.toLowerCase();
			if (lower === 'true' || lower === 'false') return { type: 'boolean', value: lower === 'true', start: t.start, end: t.end };
			if (lower === 'current' || lower === 'index') return { type: 'ident', name: lower, start: t.start, end: t.end };
			throw new FormulaError(`Unknown name "${t.text}". Properties are written prop("${t.text}")`, t.start, t.end);
		}
		return this.#primary();
	}

	#call(name: Token): FormulaNode {
		this.#expect('(', 'after the function name');
		const args: FormulaNode[] = [];
		if (!this.#isOp(')')) {
			do args.push(this.#ternary());
			while (this.#eat(','));
		}
		const close = this.#expect(')', `to close ${name.text}(`);
		const fn = name.text.toLowerCase();
		if (fn === 'prop') {
			const arg = args[0];
			if (args.length !== 1 || arg.type !== 'string') throw new FormulaError('prop() takes one property name in quotes, as in prop("Name")', name.start, close.end);
			return { type: 'prop', name: arg.value, start: name.start, end: close.end };
		}
		return { type: 'call', name: fn, args, start: name.start, end: close.end };
	}

	#primary(): FormulaNode {
		const t = this.#tok;
		switch (t.type) {
			case 'number':
				this.#i++;
				return { type: 'number', value: t.value as number, start: t.start, end: t.end };
			case 'string':
				this.#i++;
				return { type: 'string', value: t.value as string, start: t.start, end: t.end };
			case 'op':
				if (t.text === '(') {
					this.#i++;
					const inner = this.#ternary();
					this.#expect(')', 'to close the parenthesis');
					// Keep the span of the inner expression: parentheses are not part of the tree.
					return inner;
				}
				if (t.text === '[') {
					this.#i++;
					const items: FormulaNode[] = [];
					if (!this.#isOp(']')) {
						do items.push(this.#ternary());
						while (this.#eat(','));
					}
					const close = this.#expect(']', 'to close the list');
					return { type: 'list', items, start: t.start, end: close.end };
				}
				throw new FormulaError(`Unexpected ${this.#describe(t)}`, t.start, t.end);
			default:
				throw new FormulaError(`Expected a value, found ${this.#describe(t)}`, t.start, Math.max(t.end, t.start + 1));
		}
	}
}

export type ParseResult = { ok: true; ast: FormulaNode } | { ok: false; error: FormulaError };

/** Parses a formula. Never throws: a syntax error comes back with its position. */
export function parseFormula(source: string): ParseResult {
	if (source.length > MAX_FORMULA_LENGTH) return { ok: false, error: new FormulaError(`A formula holds at most ${MAX_FORMULA_LENGTH} characters`, MAX_FORMULA_LENGTH, source.length) };
	try {
		return { ok: true, ast: new Parser(lex(source), source).parse() };
	} catch (e) {
		if (e instanceof FormulaError) return { ok: false, error: e };
		throw e;
	}
}
