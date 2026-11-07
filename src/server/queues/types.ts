/** Queue messages on `JOBS` and the batched payload the consumer hands to the Workspace DO. */

/** Enqueued by the Page DO's onSave (deduplicated per page+version). */
export interface IndexPageJob {
	type: 'index-page';
	workspaceId: string;
	pageId: string;
	version: number;
}

export interface AiPropertyJob {
	type: 'ai-property';
	workspaceId: string;
	pageId: string;
	propertyId: string;
}

export interface EmailJob {
	type: 'email';
	template: string;
	to: string;
	data: Record<string, unknown>;
}

export type Job = IndexPageJob | AiPropertyJob | EmailJob;

/** What the queue consumer extracts from a page body (via the Page DO's `read()`). */
export interface PageIndexItem {
	pageId: string;
	version: number;
	/** Plain text of the body, block by block. */
	text: string;
	/** Headings in order. */
	outline: { level: number; text: string; blockId: string }[];
	/** Outgoing references found in the body. `to` is a page id. */
	links: { to: string; kind: 'mention' | 'link' | 'subpage' }[];
	/** Users mentioned with @ (for mention emails/notifications). */
	mentions: { userId: string; blockId: string }[];
	editedAt: number;
	editedBy: string | null;
}
