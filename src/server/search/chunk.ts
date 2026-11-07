/**
 * Splitting a page body into chunks, for the full-text index and for embeddings. Pure functions.
 *
 * - **Embedding chunks** (`chunkForEmbedding`): split at headings, then at paragraph boundaries into pieces
 *   of about 500 tokens (estimated at 4 characters a token). Deterministic: the same text gives the same
 *   chunks, so a chunk's hash only changes when its own words change (docs/PLAN.md "Indexing pipeline").
 * - **Full-text chunks** (`chunkForFullText`): paragraph-aligned pieces of about 1,200 characters, so
 *   `bm25()` and `snippet()` work on a passage and not on a whole page.
 */
import type { PageIndexItem } from '../queues/types';

export const CHARS_PER_TOKEN = 4;
export const EMBED_CHUNK_TOKENS = 500;
export const EMBED_CHUNK_CHARS = EMBED_CHUNK_TOKENS * CHARS_PER_TOKEN;
export const FTS_CHUNK_CHARS = 1200;
/** A body is indexed up to this many characters (the ingest keeps 256 KB; the index stays smaller). */
export const MAX_INDEXED_BODY = 128 * 1024;

/** Text FTS5 and the snippet marks must never see: control characters (the snippet marks are \u0001/\u0002). */
export const cleanText = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');

/** Packs lines into pieces of at most `max` characters; a line longer than that is cut at word boundaries. */
function pack(lines: readonly string[], max: number): string[] {
	const out: string[] = [];
	let current = '';
	const flush = () => {
		if (current.trim()) out.push(current.trim());
		current = '';
	};
	for (const line of lines) {
		if (line.length > max) {
			flush();
			let rest = line;
			while (rest.length > max) {
				let cut = rest.lastIndexOf(' ', max);
				if (cut < max * 0.5) cut = max;
				out.push(rest.slice(0, cut).trim());
				rest = rest.slice(cut).trimStart();
			}
			current = rest;
			continue;
		}
		if (current && current.length + 1 + line.length > max) flush();
		current = current ? `${current}\n${line}` : line;
	}
	flush();
	return out.filter(Boolean);
}

export function chunkForFullText(text: string): string[] {
	const lines = cleanText(text.slice(0, MAX_INDEXED_BODY))
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	return pack(lines, FTS_CHUNK_CHARS);
}

/**
 * Sections of a body: a heading line starts a new one (the outline lists the headings in document order).
 * A heading right after another heading, or at the very start, stays with the section it joins.
 */
export function sectionsOf(text: string, outline: PageIndexItem['outline']): string[][] {
	const headings = outline.map((h) => h.text.trim()).filter(Boolean);
	const sections: string[][] = [[]];
	let headingOnly = true;
	let next = 0;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		if (next < headings.length && line === headings[next]) {
			next++;
			if (!headingOnly) {
				sections.push([]);
				headingOnly = true;
			}
		} else headingOnly = false;
		sections[sections.length - 1]!.push(line);
	}
	return sections.filter((s) => s.length > 0);
}

export function chunkForEmbedding(item: Pick<PageIndexItem, 'text' | 'outline'>): string[] {
	const text = cleanText(item.text.slice(0, MAX_INDEXED_BODY));
	const chunks: string[] = [];
	for (const section of sectionsOf(text, item.outline)) chunks.push(...pack(section, EMBED_CHUNK_CHARS));
	return chunks;
}

/** A short, stable hash of a chunk (SHA-256, first 16 hex characters: collisions are irrelevant at this scale). */
export async function hashChunk(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
