/**
 * The backup file: gzip over JSON lines.
 *
 *   {"v":1,"kind":"flarion-workspace-backup","workspaceId":"...","createdAt":"...","headSeq":123,"tables":[{"name","columns","order","pk"}],...}   header
 *   {"t":"page","r":["id",1,null,...]}                                                                                                            one per row
 *   {"end":true,"rows":N,"counts":{"page":12,...},"sha256":"<hex of every line above, each followed by \n>","headSeqEnd":123}                      trailer
 *
 * The trailer is what makes a file trustworthy: a truncated gzip fails to inflate, a file cut at a line boundary has
 * no trailer, and a flipped byte fails the checksum or the counts. `verifyBackup` reads the whole file and answers
 * before any object is touched by a restore.
 */
import type { BackupHeader } from '../objects/workspace/backup';

export interface BackupTrailer {
	end: true;
	rows: number;
	counts: Record<string, number>;
	sha256: string;
	/** `seq` of the change log when the export ended: equal to the header's means no write happened during it. */
	headSeqEnd: number;
}

export class BackupCorruptError extends Error {
	override readonly name = 'BackupCorruptError';
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** workerd's `DigestStream` (WebCrypto's `digest` is not incremental); the lib typings do not carry it. */
interface DigestStreamLike extends WritableStream<BufferSource> {
	readonly digest: Promise<ArrayBuffer>;
}
const DigestStream = (crypto as unknown as { DigestStream: new (algorithm: string) => DigestStreamLike }).DigestStream;

/** A running SHA-256 over lines. */
export class LineDigest {
	readonly #stream = new DigestStream('SHA-256');
	readonly #writer = this.#stream.getWriter();
	readonly #encoder = new TextEncoder();
	add(line: string): Promise<void> {
		return this.#writer.write(this.#encoder.encode(line + '\n'));
	}
	async finish(): Promise<string> {
		await this.#writer.close();
		return hex(await this.#stream.digest);
	}
}

/** Gzips what is written and hands the compressed chunks to `onChunk` as they come out. */
export class GzipSink {
	readonly #writer: WritableStreamDefaultWriter<BufferSource>;
	readonly #pump: Promise<void>;
	readonly #encoder = new TextEncoder();
	constructor(onChunk: (chunk: Uint8Array) => Promise<void>) {
		const gzip = new CompressionStream('gzip');
		this.#writer = gzip.writable.getWriter();
		const reader = gzip.readable.getReader();
		this.#pump = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				await onChunk(value);
			}
		})();
	}
	write(line: string): Promise<void> {
		return this.#writer.write(this.#encoder.encode(line + '\n'));
	}
	async close(): Promise<void> {
		await this.#writer.close();
		await this.#pump;
	}
	async abort(reason: unknown): Promise<void> {
		await this.#writer.abort(reason).catch(() => {});
		await this.#pump.catch(() => {});
	}
}

/** An R2 sink: one `put` when the file is small, a multipart upload (8 MiB parts) when it is not. */
export const PART_BYTES = 8 * 1024 * 1024;

export class R2Sink {
	#parts: R2UploadedPart[] = [];
	#upload: R2MultipartUpload | null = null;
	#buffer: Uint8Array[] = [];
	#buffered = 0;
	bytes = 0;
	constructor(
		readonly bucket: R2Bucket,
		readonly key: string,
		readonly partBytes = PART_BYTES,
		readonly metadata: Record<string, string> = {}
	) {}

	static #concat(chunks: Uint8Array[], total: number): Uint8Array {
		const out = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.length;
		}
		return out;
	}

	async push(chunk: Uint8Array): Promise<void> {
		this.#buffer.push(chunk);
		this.#buffered += chunk.length;
		this.bytes += chunk.length;
		while (this.#buffered >= this.partBytes) await this.#flush(false);
	}

	async #flush(last: boolean): Promise<void> {
		const all = R2Sink.#concat(this.#buffer, this.#buffered);
		const take = last ? all.length : this.partBytes;
		const part = all.subarray(0, take);
		const rest = all.subarray(take);
		this.#buffer = rest.length ? [rest.slice()] : [];
		this.#buffered = rest.length;
		this.#upload ??= await this.bucket.createMultipartUpload(this.key, { customMetadata: this.metadata });
		this.#parts.push(await this.#upload.uploadPart(this.#parts.length + 1, part));
	}

	async complete(): Promise<void> {
		if (!this.#upload) {
			// Never filled a part: a plain put.
			await this.bucket.put(this.key, R2Sink.#concat(this.#buffer, this.#buffered), { customMetadata: this.metadata });
			return;
		}
		if (this.#buffered > 0) await this.#flush(true);
		await this.#upload.complete(this.#parts);
	}

	async abort(): Promise<void> {
		await this.#upload?.abort().catch(() => {});
	}
}

/** Lines of a gzip JSON-lines stream. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
	let carry = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			carry += value;
			let at: number;
			while ((at = carry.indexOf('\n')) >= 0) {
				const line = carry.slice(0, at);
				carry = carry.slice(at + 1);
				if (line) yield line;
			}
		}
	} catch (error) {
		throw new BackupCorruptError(`the file does not inflate: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (carry) throw new BackupCorruptError('the file ends in the middle of a line');
}

const isTrailer = (value: unknown): value is BackupTrailer => typeof value === 'object' && value !== null && (value as { end?: unknown }).end === true;

export interface ParsedBackup {
	header: BackupHeader;
	trailer: BackupTrailer;
}

/**
 * Reads a whole backup and checks it: header first, only well-formed rows of the header's tables, a trailer last,
 * whose checksum and counts equal what was read. Throws `BackupCorruptError` otherwise.
 */
export async function verifyBackup(body: ReadableStream<Uint8Array>): Promise<ParsedBackup> {
	const digest = new LineDigest();
	let header: BackupHeader | null = null;
	let trailer: BackupTrailer | null = null;
	const counts: Record<string, number> = {};
	let rows = 0;
	for await (const line of readLines(body)) {
		if (trailer) throw new BackupCorruptError('data after the trailer');
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new BackupCorruptError('a line is not JSON');
		}
		if (!header) {
			const h = parsed as BackupHeader;
			if (h?.kind !== 'flarion-workspace-backup' || h.v !== 1 || !Array.isArray(h.tables)) throw new BackupCorruptError('not a Flarion workspace backup (bad header)');
			header = h;
			for (const t of h.tables) counts[t.name] = 0;
			await digest.add(line);
		} else if (isTrailer(parsed)) {
			trailer = parsed;
		} else {
			const row = parsed as { t?: string; r?: unknown[] };
			const spec = header.tables.find((t) => t.name === row.t);
			if (!spec || !Array.isArray(row.r) || row.r.length !== spec.columns.length) throw new BackupCorruptError(`a row does not fit table "${String(row.t)}"`);
			counts[spec.name] = (counts[spec.name] ?? 0) + 1;
			rows++;
			await digest.add(line);
		}
	}
	if (!header) throw new BackupCorruptError('empty file');
	if (!trailer) throw new BackupCorruptError('no trailer: the file is truncated');
	const sha = await digest.finish();
	if (sha !== trailer.sha256) throw new BackupCorruptError('checksum mismatch');
	if (rows !== trailer.rows || JSON.stringify(sortKeys(counts)) !== JSON.stringify(sortKeys(trailer.counts))) throw new BackupCorruptError('row counts do not match the trailer');
	return { header, trailer };
}

const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
