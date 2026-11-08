/**
 * A small CSV reader (RFC 4180 and what spreadsheets really write): quoted fields with doubled quotes, newlines
 * inside quotes, `\n` / `\r\n` / `\r` line ends, a UTF-8 byte order mark, blank lines skipped, and a delimiter that is
 * detected (`,`, `;`, tab or `|`). No dependencies and no Worker APIs: the browser previews with the same code the
 * import Workflow runs.
 *
 * It is *resumable*: {@link readRecords} parses the complete records at the start of a text and says where it
 * stopped, so a caller can feed it a stream chunk by chunk (keep the unread tail, append the next chunk) and a
 * Workflow step can start at a record boundary it stored (`src/server/import/reader.ts`).
 *
 * Leniency: a quote in the middle of an unquoted field is a literal quote; text after the closing quote of a
 * quoted field is kept as part of the field; an unterminated quote at the end of the input takes the rest of the
 * text. Nothing here throws on malformed input except {@link CsvError} `record_too_large`, raised by callers.
 */

export const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export class CsvError extends Error {
	constructor(
		readonly code: 'record_too_large' | 'empty' | 'too_large' | 'too_many_rows',
		message: string
	) {
		super(message);
		this.name = 'CsvError';
	}
}

export const BOM = '﻿';
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export interface ReadOptions {
	/** The input is complete: a record with no terminator at the end of the text is a record. */
	final: boolean;
	/** Stop after this many records (default: all). */
	max?: number;
}

export interface ReadResult {
	records: string[][];
	/** Index in `text` after the last record read (and its line end). The unread tail starts here. */
	end: number;
}

/**
 * Reads the complete records at the start of `text`. Without `final`, a record counts only once its line end has
 * been seen (it may continue in the next chunk), and a `\r` at the very end waits for a possible `\n`.
 */
export function readRecords(text: string, delimiter: string, options: ReadOptions): ReadResult {
	const max = options.max ?? Infinity;
	const records: string[][] = [];
	const length = text.length;
	let at = 0;
	let end = 0;
	while (at < length && records.length < max) {
		const fields: string[] = [];
		let pos = at;
		let complete = false;
		let terminated = false;
		for (;;) {
			let field: string;
			if (text.charCodeAt(pos) === 34 /* " */) {
				// A quoted field: up to the closing quote, `""` standing for one quote.
				let value = '';
				let from = pos + 1;
				let closed = false;
				for (;;) {
					const quote = text.indexOf('"', from);
					if (quote === -1) {
						if (!options.final) {
							terminated = true; // incomplete: more text may follow
						} else {
							value += text.slice(from);
							pos = length;
							closed = true;
						}
						break;
					}
					value += text.slice(from, quote);
					if (text.charCodeAt(quote + 1) === 34) {
						value += '"';
						from = quote + 2;
						continue;
					}
					pos = quote + 1;
					closed = true;
					break;
				}
				if (!closed) break;
				// Anything between the closing quote and the delimiter or line end is kept as it is.
				let stray = pos;
				while (stray < length) {
					const c = text[stray]!;
					if (c === delimiter || c === '\n' || c === '\r') break;
					stray++;
				}
				value += text.slice(pos, stray);
				pos = stray;
				field = value;
			} else {
				let stop = pos;
				while (stop < length) {
					const c = text[stop]!;
					if (c === delimiter || c === '\n' || c === '\r') break;
					stop++;
				}
				field = text.slice(pos, stop);
				pos = stop;
			}
			fields.push(field);
			if (pos >= length) {
				// The text ended inside this record: complete only when the input is.
				if (options.final) {
					complete = true;
					end = length;
				}
				break;
			}
			const c = text[pos]!;
			if (c === delimiter) {
				pos++;
				if (pos >= length) {
					// A trailing delimiter: one more empty field, once the input is complete.
					if (options.final) {
						fields.push('');
						complete = true;
						end = length;
					}
					break;
				}
				continue;
			}
			// A line end.
			if (c === '\r') {
				if (pos + 1 >= length && !options.final) break; // `\r` may be the first half of `\r\n`
				pos += text[pos + 1] === '\n' ? 2 : 1;
			} else pos++;
			complete = true;
			end = pos;
			break;
		}
		if (!complete || terminated) break;
		at = end;
		// A blank line is no record.
		if (fields.length === 1 && fields[0] === '') continue;
		records.push(fields);
	}
	// Blank lines before the stop are consumed too (they hold nothing), but not past the record cap.
	return { records, end: Math.max(end, 0) };
}

/** The number of records of `text` per delimiter candidate, for {@link detectDelimiter}. */
function columnCounts(text: string, delimiter: string): number[] {
	return readRecords(text, delimiter, { final: true, max: 40 }).records.map((r) => r.length);
}

/**
 * Picks the delimiter of a CSV from its first records: the candidate under which the records have the most
 * columns consistently. A single column (no candidate splits anything) is read with a comma.
 */
export function detectDelimiter(sample: string): Delimiter {
	const text = stripBom(sample);
	let best: Delimiter = ',';
	let bestScore = 0;
	for (const delimiter of DELIMITERS) {
		const counts = columnCounts(text, delimiter);
		if (counts.length === 0) continue;
		const modal = new Map<number, number>();
		for (const n of counts) modal.set(n, (modal.get(n) ?? 0) + 1);
		let columns = 1;
		let agree = 0;
		for (const [n, times] of modal) if (times > agree || (times === agree && n > columns)) [columns, agree] = [n, times];
		if (columns < 2) continue;
		// Consistency first (the share of records with the modal width), then width.
		const score = (agree / counts.length) * 1000 + columns;
		if (score > bestScore) {
			bestScore = score;
			best = delimiter;
		}
	}
	return best;
}

/** UTF-8 length of a string, without allocating it. */
export function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

export interface ParsedCsv {
	delimiter: Delimiter;
	records: string[][];
}

/** Parses a whole CSV text (small inputs: tests, the browser's preview of a sample). */
export function parseCsv(text: string, options: { delimiter?: Delimiter; max?: number } = {}): ParsedCsv {
	const body = stripBom(text);
	const delimiter = options.delimiter ?? detectDelimiter(body);
	return { delimiter, records: readRecords(body, delimiter, { final: true, max: options.max }).records };
}
