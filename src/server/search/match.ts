/**
 * Pure helpers for search: turning user input into a safe FTS5 MATCH expression, deciding whether a query
 * reads like a question, and merging ranked lists by reciprocal rank fusion. No Cloudflare imports.
 */

/** Words and characters FTS5's `unicode61` tokenizer treats as a token: letters and digits of any script. */
const TOKEN = /[\p{L}\p{N}]+/gu;
/** More than this many tokens would only slow the query down. */
export const MAX_QUERY_TOKENS = 16;

/** The words of a query, in order, lowercased and stripped of everything FTS5 would read as syntax. */
export function queryTokens(input: string): string[] {
	return (input.normalize('NFKC').match(TOKEN) ?? []).slice(0, MAX_QUERY_TOKENS);
}

/**
 * Quotes user input for `MATCH`: every word becomes a double-quoted phrase (inner quotes doubled, though the
 * tokenizer regex leaves none), so `NEAR`, `AND`, `OR`, `NOT`, `*`, `-`, `^`, parentheses and `col:` filters
 * all become plain words. The result is wrapped in a `text :` column filter: the `field` column holds the
 * words "title", "property" and "body", which must never match a query. `prefix` turns the last word into a
 * prefix query (quick find: the word being typed). Null when the input holds no word.
 */
export function buildMatch(input: string, options: { prefix?: boolean; dropStopwords?: boolean } = {}): string | null {
	let tokens = queryTokens(input);
	if (options.dropStopwords) {
		// A question ("how do we launch?") asks for its content words: AND-ing the filler would match nothing.
		const content = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
		if (content.length > 0) tokens = content;
	}
	if (tokens.length === 0) return null;
	const phrases = tokens.map((t, i) => {
		const quoted = `"${t.replaceAll('"', '""')}"`;
		return options.prefix && i === tokens.length - 1 ? `${quoted} *` : quoted;
	});
	return `text : (${phrases.join(' ')})`;
}

const STOPWORDS = new Set([
	'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'by', 'from', 'about', 'as', 'it', 'its', 'that', 'this', 'these', 'those',
	'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our', 'your', 'their', 'me', 'us', 'there', 'here',
	'what', 'whats', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which',
	'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'have', 'has', 'had',
	'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'en', 'dans', 'pour', 'sur', 'avec', 'que', 'qui', 'quoi', 'quand', 'comment', 'pourquoi', 'est', 'sont', 'nous', 'vous', 'je', 'on'
]);

const QUESTION_WORDS = new Set([
	'what', 'whats', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which',
	'can', 'could', 'should', 'would', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'will',
	'comment', 'pourquoi', 'quand', 'quel', 'quelle', 'quels', 'quelles', 'qui', 'est-ce'
]);

/** Heuristic for semantic search: a question word first, a question mark, or more than six words. */
export function looksLikeQuestion(input: string): boolean {
	const text = input.trim();
	if (!text) return false;
	if (text.includes('?')) return true;
	const words = text.split(/\s+/);
	if (words.length > 6) return true;
	return QUESTION_WORDS.has(words[0]!.toLowerCase().replace(/[^\p{L}-]/gu, ''));
}

export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each list contributes `1 / (k + rank)` (rank from 1) to every id it holds; ids are
 * sorted by total score, ties by the earliest list and position they appear at. Duplicates inside one list
 * count once, at their first position.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = RRF_K): { id: string; score: number }[] {
	const score = new Map<string, number>();
	const first = new Map<string, number>();
	let order = 0;
	for (const list of lists) {
		const seen = new Set<string>();
		let rank = 0;
		for (const id of list) {
			if (seen.has(id)) continue;
			seen.add(id);
			rank++;
			score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
			if (!first.has(id)) first.set(id, order++);
		}
	}
	return [...score.entries()]
		.map(([id, s]) => ({ id, score: s }))
		.sort((a, b) => b.score - a.score || first.get(a.id)! - first.get(b.id)!);
}

const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';
export const SNIPPET_MARKS = { open: MARK_OPEN, close: MARK_CLOSE } as const;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes an FTS5 snippet taken with the private mark characters, then turns the marks into `<mark>`. */
export function renderSnippet(raw: string): string {
	return raw
		.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
		.replaceAll(MARK_OPEN, '<mark>')
		.replaceAll(MARK_CLOSE, '</mark>');
}

/** HTML-escaped plain excerpt (no highlight). */
export function plainSnippet(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const cut = flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
	return cut.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Lowercase with diacritics removed, for "contains every word" checks outside FTS5. */
export const foldText = (s: string): string => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
