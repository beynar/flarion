/**
 * Reads a CSV from R2 a few hundred records at a time. A Workflow step starts at a byte offset (a record boundary
 * it stored), streams the object from there, feeds `readRecords` chunk by chunk and stops after `max` records, so
 * no step holds the file: the cost of a step is its chunk, however big the file.
 *
 * Encoding: UTF-8, or Windows-1252 for a file that is not valid UTF-8 (what spreadsheets in many locales write).
 * `ignoreBOM` keeps the byte order mark in the decoded text so the byte accounting stays exact; it is dropped here.
 */
import { SAMPLE_BYTES } from '../../lib/shared/import/schemas';
import { BOM, CsvError, detectDelimiter, readRecords, utf8Length } from '../../lib/shared/import/csv';

export type Encoding = 'utf-8' | 'windows-1252';

/** A single record bigger than this is refused (a quote that never closes would otherwise swallow the file). */
export const MAX_RECORD_CHARS = 1024 * 1024;

const byteLength = (text: string, encoding: Encoding): number => (encoding === 'utf-8' ? utf8Length(text) : text.length);

/** Whether `bytes` is valid UTF-8, allowing a multi-byte character cut by the end of the sample. */
function isUtf8(bytes: Uint8Array, truncated: boolean): boolean {
	const view = truncated ? bytes.subarray(0, Math.max(0, bytes.length - 3)) : bytes;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(view);
		return true;
	} catch {
		return false;
	}
}

export interface Sample {
	encoding: Encoding;
	delimiter: ReturnType<typeof detectDelimiter>;
	/** The first record. */
	header: string[];
	/** Records after it, as many as the sample holds. */
	rows: string[][];
	/** Byte offset of the record after the header. */
	offset: number;
	/** The whole file fit in the sample. */
	complete: boolean;
}

/** Reads the start of the object: encoding, delimiter, header and sample rows. */
export async function readSample(bucket: R2Bucket, key: string, options: { delimiter?: Sample['delimiter']; maxRows?: number } = {}): Promise<Sample> {
	const object = await bucket.get(key, { range: { offset: 0, length: SAMPLE_BYTES } });
	if (!object) throw new CsvError('empty', 'The uploaded file is gone');
	const bytes = new Uint8Array(await object.arrayBuffer());
	const complete = object.size <= SAMPLE_BYTES;
	const encoding: Encoding = isUtf8(bytes, !complete) ? 'utf-8' : 'windows-1252';
	let text = new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes);
	let bom = 0;
	if (text.startsWith(BOM)) {
		text = text.slice(1);
		bom = utf8Length(BOM);
	}
	const delimiter = options.delimiter ?? detectDelimiter(text);
	// Without the whole file, the last record of the sample may be cut: only complete records count.
	const read = readRecords(text, delimiter, { final: complete, max: (options.maxRows ?? 1000) + 1 });
	const [header, ...rows] = read.records;
	if (!header) throw new CsvError('empty', 'The CSV has no header row');
	const first = readRecords(text, delimiter, { final: complete, max: 1 });
	return { encoding, delimiter, header, rows, offset: bom + byteLength(text.slice(0, first.end), encoding), complete };
}

export interface Chunk {
	records: string[][];
	/** Byte offset where the next chunk starts. */
	offset: number;
	/** No record is left after this chunk. */
	done: boolean;
}

/** Reads up to `max` records starting at byte `offset` (a record boundary). */
export async function readChunk(
	bucket: R2Bucket,
	key: string,
	options: { offset: number; delimiter: string; encoding: Encoding; max: number }
): Promise<Chunk> {
	if (options.offset > 0) {
		// A range that starts at (or past) the end is an error in R2: a file whose last chunk filled up ends here.
		const head = await bucket.head(key);
		if (!head) throw new CsvError('empty', 'The uploaded file is gone');
		if (options.offset >= head.size) return { records: [], offset: options.offset, done: true };
	}
	const object = await bucket.get(key, options.offset > 0 ? { range: { offset: options.offset } } : undefined);
	if (!object) throw new CsvError('empty', 'The uploaded file is gone');
	const reader = object.body.getReader();
	const decoder = new TextDecoder(options.encoding, { ignoreBOM: true });
	const records: string[][] = [];
	let buffer = '';
	let consumed = 0;
	let started = options.offset > 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (!started && buffer.length > 0) {
				started = true;
				if (buffer.startsWith(BOM)) {
					buffer = buffer.slice(1);
					consumed += utf8Length(BOM);
				}
			}
			const read = readRecords(buffer, options.delimiter, { final: done, max: options.max - records.length });
			records.push(...read.records);
			consumed += byteLength(buffer.slice(0, read.end), options.encoding);
			buffer = buffer.slice(read.end);
			if (records.length >= options.max) return { records, offset: options.offset + consumed, done: false };
			if (done) return { records, offset: options.offset + consumed, done: true };
			if (buffer.length > MAX_RECORD_CHARS) throw new CsvError('record_too_large', 'A record is larger than 1 MB: is a quote left open?');
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
}
