/**
 * A streaming zip writer over `fflate` (0.8.2, pinned: pure JavaScript, no workers or WASM, so it runs in workerd) and
 * an R2 sink for it. The export Workflow writes pages and files through it, one at a time, so the archive's size is
 * bounded by R2 (and a part of it in memory), not by the Worker's 128 MB.
 *
 * - Pages and other text are deflated; files go in as they are (`store`): most are images and videos already.
 * - `R2ZipSink` buffers the archive into parts of {@link PART_BYTES} and uploads them as an R2 multipart upload; an
 *   archive smaller than one part is a single `put`.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export type ZipSink = (chunk: Uint8Array) => Promise<void>;

const encoder = new TextEncoder();

export class ZipWriter {
	readonly #zip: Zip;
	readonly #sink: ZipSink;
	#queue: Uint8Array[] = [];
	#error: Error | null = null;
	#finished = false;
	/** Files written so far. */
	files = 0;

	constructor(sink: ZipSink) {
		this.#sink = sink;
		this.#zip = new Zip((error, chunk) => {
			if (error) this.#error = error instanceof Error ? error : new Error(String(error));
			else this.#queue.push(chunk);
		});
	}

	async #flush(): Promise<void> {
		if (this.#error) throw this.#error;
		const queued = this.#queue;
		this.#queue = [];
		for (const chunk of queued) await this.#sink(chunk);
	}

	/** Adds a text file (deflated). */
	async addText(path: string, text: string, modified: Date = new Date()): Promise<void> {
		const file = new ZipDeflate(path, { level: 6 });
		file.mtime = modified;
		this.#zip.add(file);
		file.push(encoder.encode(text), true);
		this.files++;
		await this.#flush();
	}

	/** Adds a file from a stream, stored without compression. */
	async addStream(path: string, stream: ReadableStream<Uint8Array>, modified: Date = new Date()): Promise<void> {
		const file = new ZipPassThrough(path);
		file.mtime = modified;
		this.#zip.add(file);
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				file.push(value, false);
				await this.#flush();
			}
			file.push(new Uint8Array(0), true);
		} finally {
			reader.releaseLock();
		}
		this.files++;
		await this.#flush();
	}

	/** Writes the central directory. The archive is complete once this resolves. */
	async finish(): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		this.#zip.end();
		await this.#flush();
	}
}

/** Smallest part R2 accepts is 5 MiB (but the last); this keeps a margin. */
export const PART_BYTES = 8 * 1024 * 1024;

/** An archive in R2: `write` takes the zip's chunks in order, `close` completes the object, `abort` discards it. */
export class R2ZipSink {
	readonly #bucket: R2Bucket;
	readonly #key: string;
	readonly #options: R2PutOptions;
	#buffer: Uint8Array[] = [];
	#buffered = 0;
	#upload: R2MultipartUpload | null = null;
	#parts: R2UploadedPart[] = [];
	/** Bytes written to R2 or buffered. */
	bytes = 0;

	constructor(bucket: R2Bucket, key: string, options: R2PutOptions = {}) {
		this.#bucket = bucket;
		this.#key = key;
		this.#options = options;
	}

	readonly write: ZipSink = async (chunk) => {
		if (chunk.byteLength === 0) return;
		this.#buffer.push(chunk);
		this.#buffered += chunk.byteLength;
		this.bytes += chunk.byteLength;
		if (this.#buffered >= PART_BYTES) await this.#uploadPart();
	};

	#take(): Uint8Array {
		const joined = new Uint8Array(this.#buffered);
		let at = 0;
		for (const piece of this.#buffer) {
			joined.set(piece, at);
			at += piece.byteLength;
		}
		this.#buffer = [];
		this.#buffered = 0;
		return joined;
	}

	async #uploadPart(): Promise<void> {
		this.#upload ??= await this.#bucket.createMultipartUpload(this.#key, this.#options);
		this.#parts.push(await this.#upload.uploadPart(this.#parts.length + 1, this.#take()));
	}

	async close(): Promise<number> {
		if (!this.#upload) {
			await this.#bucket.put(this.#key, this.#take(), this.#options);
			return this.bytes;
		}
		if (this.#buffered > 0) await this.#uploadPart();
		await this.#upload.complete(this.#parts);
		return this.bytes;
	}

	async abort(): Promise<void> {
		await this.#upload?.abort().catch(() => undefined);
		this.#upload = null;
	}
}
