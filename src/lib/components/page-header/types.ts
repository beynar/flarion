export type PageHeaderAccess = 'read' | 'comment' | 'write' | 'full';

export interface PageHeaderPage {
	id: string;
	title: string;
	/** An emoji, or `null` for none. */
	icon: string | null;
	/** A preset key (`dawn`...), an image address, or `null` for none: see `covers.ts`. */
	cover: string | null;
	/** Vertical position of the cover image, 0 (top) to 100 (bottom). Default 50. */
	coverPosition?: number;
}

export interface PresenceUser {
	userId: string;
	name: string;
	color?: string;
}

/** Only people who may write change the header: `read` and `comment` see it as text. */
export const canEditHeader = (access: PageHeaderAccess) => access === 'write' || access === 'full';
