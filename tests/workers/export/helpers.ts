/** Fixtures of the export and published-page tests: a workspace with a page that uses every block type. */
import type { JSONBlock, JSONDoc, JSONText } from 'edytor/crdt/edytor';
import { bytesOf, createFixture, uploadFile, type FilesFixture } from '../files/helpers';
import { roomOf } from '../history/helpers';

export { bytesOf, createFixture, roomOf, uploadFile };
export type { FilesFixture };

export const t = (text: string, marks?: JSONText['marks']): JSONText => ({ text, ...(marks ? { marks } : {}) });
export const para = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [t(text)] });

export interface World {
	fx: FilesFixture;
	/** A page under the main one, with a body of its own. */
	childId: string;
	/** A page nobody published and nothing links by grant. */
	otherId: string;
	/** The inline database: its page id, its collection id. */
	databaseId: string;
	collectionId: string;
	/** An uploaded image and file, as the editor stores them (`<origin>/files/<id>?ws=<workspace>`). */
	imageId: string;
	fileId: string;
	imageUrl: string;
	fileUrl: string;
	slug: string;
}

/** A workspace with a main page, a subpage, a database with three rows, an image and a file. */
export async function createWorld(): Promise<World> {
	const fx = await createFixture();
	const { rpc } = fx;
	const general = (await rpc.workspace.teamspaces.list()).find((team) => team.name === 'General');
	const child = await rpc.page.create({ parentId: fx.pageId, values: { title: 'Child page' }, icon: '🌱' });
	const other = await rpc.page.create({ parentId: null, teamspaceId: general?.id ?? null, values: { title: 'Secret plans' } });
	await roomOf(fx, child.id).seedFrom({ children: [para('c1', 'Body of the child page.')] });

	const database = await rpc.page.create({ parentId: fx.pageId, isDatabase: true, values: { title: 'Tasks' } });
	await rpc.property.create({ property: { id: 'status', name: 'Status', type: 'select', config: { options: [{ id: 'todo', name: 'To do', color: 'red' }, { id: 'done', name: 'Done', color: 'green' }] } } });
	await rpc.property.create({ property: { id: 'points', name: 'Points', type: 'number', config: {} } as never });
	const { id: collectionId } = await rpc.collection.create({ pageId: database.id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: database.id }] } });
	await rpc.view.create({ collectionId, type: 'table', name: 'All', columns: { columns: [{ prop: 'status' }, { prop: 'points' }], options: {} } } as never);
	for (const [i, status] of ['todo', 'done', 'todo'].entries()) {
		await rpc.page.create({ parentId: database.id, values: { title: `Task ${i + 1}`, status, points: (i + 1) * 3 } as never });
	}

	const ada = fx.ada;
	const image = await uploadFile(fx, ada, { name: 'picture.png', type: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]) });
	const file = await uploadFile(fx, ada, { name: 'notes.txt', type: 'text/plain', bytes: bytesOf('hello from the file') });
	const origin = 'http://localhost:5173';
	const slug = (await fx.world.env.DB.prepare('SELECT "slug" FROM "workspace" WHERE "id" = ?').bind(fx.workspaceId).first<{ slug: string }>())!.slug;
	return {
		fx,
		childId: child.id,
		otherId: other.id,
		databaseId: database.id,
		collectionId,
		imageId: image.info.id,
		fileId: file.info.id,
		imageUrl: `${origin}/files/${image.info.id}?ws=${fx.workspaceId}`,
		fileUrl: `${origin}/files/${file.info.id}?ws=${fx.workspaceId}`,
		slug
	};
}

/** Every block type the app writes, with marks and inline atoms. */
export function everyBlock(world: World): JSONDoc {
	const { childId, collectionId } = world;
	return {
		children: [
			{ id: 'h1', type: 'heading', data: { level: 'h1' }, content: [t('Heading one')] },
			{ id: 'h2', type: 'heading', data: { level: 'h2' }, content: [t('Heading two')] },
			{
				id: 'p1',
				type: 'paragraph',
				content: [
					t('Plain '),
					t('bold', { bold: true }),
					t(' '),
					t('italic', { italic: true }),
					t(' '),
					t('inline code', { code: true }),
					t(' '),
					t('struck', { strike: true }),
					t(' '),
					t('a link', { link: { href: 'https://example.com/a' } }),
					t(' '),
					t('coloured', { color: '#cf5148' }),
					t(' with '),
					{ type: 'mention', data: { id: 'user-1', label: 'Ada' } },
					t(' and '),
					{ type: 'mention', data: { id: `page:${childId}`, label: 'Child page' } },
					t(' and '),
					{ type: 'pageLink', data: { id: childId, title: 'Child page', icon: '🌱' } },
					t(' on '),
					{ type: 'date_mention', data: { start: '2026-11-07' } },
					t(' with '),
					{ type: 'inlineEquation', data: { expression: 'x^2' } }
				]
			},
			{ id: 'b1', type: 'bulleted-list-item', content: [t('bullet item')] },
			{ id: 'n1', type: 'numbered-list-item', content: [t('first step')] },
			{ id: 'n2', type: 'numbered-list-item', content: [t('second step')] },
			{ id: 'td1', type: 'todo-item', data: { checked: true }, content: [t('done task')] },
			{ id: 'td2', type: 'todo-item', data: { checked: false }, content: [t('open task')] },
			{ id: 'tg', type: 'toggle', content: [t('Toggle title')], children: [para('tgc', 'toggle body')] },
			{ id: 'th', type: 'toggle-heading', data: { level: 'h2' }, content: [t('Toggle heading')], children: [para('thc', 'inside the heading')] },
			{ id: 'q', type: 'quote', content: [t('A wise quote')] },
			{ id: 'co', type: 'callout', data: { icon: '💡' }, content: [t('Callout text')] },
			{ id: 'dv', type: 'divider' },
			{
				id: 'cd',
				type: 'code',
				data: { language: 'ts' },
				children: [
					{ id: 'cl1', type: 'codeLine', content: [t('const small = 1 < 2;')] },
					{ id: 'cl2', type: 'codeLine', content: [t('console.log(small);')] }
				]
			},
			{
				id: 'tb',
				type: 'table',
				data: { columns: [{ id: 'c1' }, { id: 'c2' }], headerRow: true },
				children: [
					{ id: 'r1', type: 'tableRow', children: [{ id: 'r1a', type: 'tableCell', data: { column: 'c1' }, content: [t('Fruit')] }, { id: 'r1b', type: 'tableCell', data: { column: 'c2' }, content: [t('Count')] }] },
					{ id: 'r2', type: 'tableRow', children: [{ id: 'r2a', type: 'tableCell', data: { column: 'c1' }, content: [t('Apple')] }, { id: 'r2b', type: 'tableCell', data: { column: 'c2' }, content: [t('12')] }] }
				]
			},
			{ id: 'im', type: 'image', data: { src: world.imageUrl, alt: 'A picture' }, content: [t('Image caption')] },
			{ id: 'fl', type: 'file', data: { src: world.fileUrl, name: 'notes.txt' }, content: [t('File caption')] },
			{ id: 'vd', type: 'video', data: { src: 'https://cdn.example.com/clip.mp4' } },
			{ id: 'au', type: 'audio', data: { src: 'https://cdn.example.com/sound.mp3' } },
			{ id: 'em', type: 'embed', data: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
			{ id: 'bm', type: 'bookmark', data: { url: 'https://example.com/post', title: 'A bookmarked post' } },
			{ id: 'pg', type: 'page', data: { pageId: childId, title: 'Child page' } },
			{ id: 'tc', type: 'toc' },
			{ id: 'eq', type: 'equation', data: { expression: 'E=mc^2' } },
			{
				id: 'cs',
				type: 'columns',
				children: [
					{ id: 'col1', type: 'column', children: [para('l', 'left column')] },
					{ id: 'col2', type: 'column', children: [para('r', 'right column')] }
				]
			},
			{ id: 'dbv', type: 'database_view', data: { collectionId, viewId: null, localFilter: null } },
			{ id: 'bc', type: 'breadcrumb' }
		]
	};
}

/** The text of a response's `Set-Cookie`-free JSON, for readable failures. */
export const head = (text: string, n = 400) => (text.length > n ? `${text.slice(0, n)}…` : text);

const FORBIDDEN = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form', 'link', 'meta', 'base', 'template', 'noscript', 'textarea', 'button', 'frame'];

/**
 * What a browser would run or load from `html`, found by a deliberately naive, quote-aware scan: the tags and attributes
 * of the markup (text and quoted values are not markup). Returns the problems, empty when the page is inert.
 */
export function activeContent(html: string): string[] {
	const problems: string[] = [];
	for (const match of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
		const name = match[1]!.toLowerCase();
		const rest = match[2]!;
		const bare = rest.replace(/"[^"]*"|'[^']*'/g, '""');
		if (FORBIDDEN.includes(name)) problems.push(`<${name}>`);
		for (const handler of bare.matchAll(/\son[a-z]+\s*=/gi)) problems.push(`handler ${handler[0].trim()} on <${name}>`);
		for (const attribute of rest.matchAll(/\s(?:href|src|action|formaction|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
			const value = (attribute[1] ?? attribute[2] ?? attribute[3] ?? '').replace(/&#x?[0-9a-f]+;?|&colon;|&tab;|&newline;|[\s\u0000-\u001f]/gi, '').toLowerCase();
			if (/^(javascript|vbscript|data:text|data:application)/.test(value)) problems.push(`${attribute[0].trim()} on <${name}>`);
		}
	}
	return problems;
}
