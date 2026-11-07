/**
 * Page indexing: turn a room document (edytor JSON) into the `PageIndexItem` the Workspace DO ingests
 * (full-text body, outline, references and mentions), and run a deduplicated, throttled batch of
 * `index-page` jobs. Pure extraction is separate from the queue plumbing so both are testable.
 */
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import { PAGE_MENTION_PREFIX } from '../../lib/shared/blocks/page-mention.js';
import { roomName } from '../rooms/names';
import type { PageIdentity } from '../objects/page/page-meta';
import type { PageIndexSource } from '../objects/page/page-do';
import type { IndexPageJob, PageIndexItem } from './types';
import { embedPages } from '../search/embed';

export { PAGE_MENTION_PREFIX };

/** Inline atoms whose text reads as part of the sentence. */
function atomText(type: string, data: Record<string, unknown> | undefined): string {
	switch (type) {
		case 'mention':
			return typeof data?.label === 'string' ? data.label : '';
		case 'pageLink':
			return typeof data?.title === 'string' ? data.title : '';
		case 'inlineEquation':
			return typeof data?.expression === 'string' ? data.expression : '';
		case 'date_mention':
			return typeof data?.start === 'string' ? data.start : '';
		default:
			return '';
	}
}

const headingLevelOf = (block: JSONBlock): number | null => {
	if (block.type !== 'heading' && block.type !== 'toggle-heading') return null;
	const level = block.data?.level;
	return level === 'h2' ? 2 : level === 'h3' ? 3 : 1;
};

/** The text a block shows by itself (its own content, not its children). */
function ownText(block: JSONBlock): string {
	let text = '';
	for (const part of block.content ?? []) {
		if ('text' in part && typeof part.text === 'string') text += part.text;
		else if ('type' in part) text += atomText(part.type, part.data as Record<string, unknown> | undefined);
	}
	// Block kinds that keep their words in data rather than content.
	if (!text) {
		if (block.type === 'equation' && typeof block.data?.expression === 'string') text = block.data.expression;
		else if (block.type === 'page' && typeof block.data?.title === 'string') text = block.data.title;
	}
	return text;
}

export interface ExtractMeta {
	pageId: string;
	version: number;
	editedAt: number;
	editedBy: string | null;
}

/** Plain text, outline, references and mentions of one page body. */
export function extractPageIndexItem(doc: JSONDoc, meta: ExtractMeta): PageIndexItem {
	const lines: string[] = [];
	const outline: PageIndexItem['outline'] = [];
	const links = new Map<string, PageIndexItem['links'][number]>();
	const mentions: PageIndexItem['mentions'] = [];
	const seenMentions = new Set<string>();
	const link = (to: string, kind: 'mention' | 'link' | 'subpage') => {
		if (to && !links.has(`${kind}:${to}`)) links.set(`${kind}:${to}`, { to, kind });
	};

	const visit = (block: JSONBlock, index: number) => {
		const blockId = block.id ?? `b${index}`;
		const text = ownText(block);
		if (text.trim()) lines.push(text);
		const level = headingLevelOf(block);
		if (level !== null && text.trim()) outline.push({ level, text: text.trim(), blockId });
		if (block.type === 'page' && typeof block.data?.pageId === 'string') link(block.data.pageId, 'subpage');
		for (const part of block.content ?? []) {
			if (!('type' in part)) continue;
			const data = part.data as Record<string, unknown> | undefined;
			if (part.type === 'pageLink' && typeof data?.id === 'string') link(data.id, 'link');
			if (part.type === 'mention' && typeof data?.id === 'string') {
				if (data.id.startsWith(PAGE_MENTION_PREFIX)) link(data.id.slice(PAGE_MENTION_PREFIX.length), 'mention');
				else if (!seenMentions.has(`${blockId}:${data.id}`)) {
					seenMentions.add(`${blockId}:${data.id}`);
					mentions.push({ userId: data.id, blockId });
				}
			}
		}
		block.children?.forEach(visit);
	};
	(doc.children ?? []).forEach(visit);

	return {
		pageId: meta.pageId,
		version: meta.version,
		text: lines.join('\n'),
		outline,
		links: [...links.values()],
		mentions,
		editedAt: meta.editedAt,
		editedBy: meta.editedBy
	};
}

// ───────────── the queue side ─────────────

/** At most one index per page in this window (docs/PLAN.md "Between Durable Objects"). */
export const INDEX_WINDOW_SECONDS = 30;
/** Pages per Workspace DO call. */
export const INGEST_BATCH = 100;
const MAX_BACKOFF_SECONDS = 300;

/** What the Workspace DO exposes for ingestion (implemented by the Sync core). */
export interface WorkspaceIngestApi {
	ingestPages(items: PageIndexItem[]): unknown;
}

/** The minimum of a queue message the batch needs. */
export interface JobMessage<T> {
	readonly body: T;
	readonly attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

/** Retry delay for the nth attempt: 5 s, 10 s, 20 s... up to 5 minutes. */
export const backoffSeconds = (attempts: number) =>
	Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** Math.max(0, attempts - 1));

interface Stamp {
	version: number;
	at: number;
}
const stampKey = (workspaceId: string, pageId: string) => `index:${workspaceId}:${pageId}`;

type ThrottleEnv = Pick<Env, 'CACHE' | 'PAGE' | 'WORKSPACE'>;

/**
 * Index a batch of `index-page` messages:
 * - messages for one page collapse to the newest version; the rest are acked;
 * - a version already indexed is acked; a page indexed less than 30 s ago is retried after the window
 *   (so the latest edit is always indexed, never dropped);
 * - pages are read through their Page DO, extracted, grouped by workspace and ingested up to 100 per call;
 * - a failed ingest retries its messages with exponential backoff; a success acks them.
 */
export async function indexPages(
	env: ThrottleEnv,
	messages: readonly JobMessage<IndexPageJob>[],
	now: number = Date.now()
): Promise<{ indexed: number; throttled: number; duplicates: number; failed: number }> {
	const result = { indexed: 0, throttled: 0, duplicates: 0, failed: 0 };

	// Newest version per page; every other message of the page is a duplicate.
	const newest = new Map<string, JobMessage<IndexPageJob>>();
	const superseded: JobMessage<IndexPageJob>[] = [];
	for (const message of messages) {
		const key = `${message.body.workspaceId}:${message.body.pageId}`;
		const held = newest.get(key);
		if (!held) newest.set(key, message);
		else if (message.body.version > held.body.version) {
			superseded.push(held);
			newest.set(key, message);
		} else superseded.push(message);
	}
	for (const message of superseded) {
		message.ack();
		result.duplicates++;
	}

	// Throttle against the last index of each page.
	const due: JobMessage<IndexPageJob>[] = [];
	await Promise.all(
		[...newest.values()].map(async (message) => {
			const { workspaceId, pageId, version } = message.body;
			const stamp = await env.CACHE.get<Stamp>(stampKey(workspaceId, pageId), 'json');
			if (stamp && stamp.version >= version) {
				message.ack();
				result.duplicates++;
			} else if (stamp && now - stamp.at < INDEX_WINDOW_SECONDS * 1000) {
				const remaining = Math.ceil((INDEX_WINDOW_SECONDS * 1000 - (now - stamp.at)) / 1000);
				message.retry({ delaySeconds: remaining + 1 });
				result.throttled++;
			} else due.push(message);
		})
	);

	// Group by workspace, then ingest up to 100 pages per call.
	const byWorkspace = new Map<string, JobMessage<IndexPageJob>[]>();
	for (const message of due) {
		const list = byWorkspace.get(message.body.workspaceId) ?? [];
		list.push(message);
		byWorkspace.set(message.body.workspaceId, list);
	}
	for (const [workspaceId, group] of byWorkspace) {
		for (let at = 0; at < group.length; at += INGEST_BATCH) {
			const chunk = group.slice(at, at + INGEST_BATCH);
			const read = await Promise.all(chunk.map((message) => readItem(env, message)));
			const ready = chunk.flatMap((message, i) => (read[i] ? [{ message, item: read[i]! }] : []));
			// A page that could not be read retries on its own.
			chunk.forEach((message, i) => {
				if (!read[i]) {
					message.retry({ delaySeconds: backoffSeconds(message.attempts) });
					result.failed++;
				}
			});
			if (ready.length === 0) continue;
			try {
				const workspace = env.WORKSPACE.getByName(workspaceId) as unknown as WorkspaceIngestApi;
				await workspace.ingestPages(ready.map(({ item }) => item));
				// Vectorize chunks: never throws, quiet without AI/Vectorize (full-text search is already fresh).
				await embedPages(env as Env, workspaceId, ready.map(({ item }) => item));
			} catch (error) {
				console.warn(`index: ingestPages failed for ${workspaceId}`, String(error));
				for (const { message } of ready) {
					message.retry({ delaySeconds: backoffSeconds(message.attempts) });
					result.failed++;
				}
				continue;
			}
			await Promise.all(
				ready.map(async ({ message, item }) => {
					await env.CACHE.put(
						stampKey(workspaceId, item.pageId),
						JSON.stringify({ version: message.body.version, at: now } satisfies Stamp),
						{ expirationTtl: 3600 }
					).catch(() => {});
					message.ack();
					result.indexed++;
				})
			);
		}
	}
	return result;
}

async function readItem(env: ThrottleEnv, message: JobMessage<IndexPageJob>): Promise<PageIndexItem | null> {
	const { workspaceId, pageId, version } = message.body;
	try {
		const identity: PageIdentity = { workspaceId, pageId };
		const page = env.PAGE.getByName(roomName(identity.workspaceId, identity.pageId)) as unknown as {
			readForIndex(): Promise<PageIndexSource>;
		};
		const source = await page.readForIndex();
		return extractPageIndexItem(source.doc, {
			pageId,
			version,
			editedAt: source.editedAt ?? version,
			editedBy: source.editedBy
		});
	} catch (error) {
		console.warn(`index: could not read page ${pageId}`, String(error));
		return null;
	}
}
