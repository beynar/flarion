/**
 * The `@` menu: people and pages in one list. Both are `mention` atoms (`{ id, label }`); a page's id
 * is prefixed (`page:<id>`) so the indexer and the renderer can tell them apart without a second
 * trigger on the same character (src/server/queues/index-pages.ts reads the same prefix).
 */
import type { MentionItem, PageLinkItem } from 'edytor';
import { PAGE_MENTION_PREFIX } from '#lib/shared/blocks/page-mention.ts';

export { PAGE_MENTION_PREFIX };

export const isPageMention = (id: string) => id.startsWith(PAGE_MENTION_PREFIX);
export const pageIdOfMention = (id: string) => id.slice(PAGE_MENTION_PREFIX.length);

export type PeopleSearch = (q: string) => Promise<{ id: string; name: string }[]>;
export type PagesSearch = (q: string) => Promise<{ id: string; title: string; icon: string | null }[]>;

export function mentionItems(searchPeople?: PeopleSearch, searchPages?: PagesSearch) {
	return async (query: string): Promise<MentionItem[]> => {
		const [people, pages] = await Promise.all([searchPeople?.(query) ?? [], searchPages?.(query) ?? []]);
		return [
			...people.map((person) => ({ id: person.id, label: person.name, description: 'Person' })),
			...pages.map((page) => ({
				id: `${PAGE_MENTION_PREFIX}${page.id}`,
				label: `${page.icon ? `${page.icon} ` : ''}${page.title || 'Untitled'}`,
				description: 'Page'
			}))
		];
	};
}

export function pageLinkItems(searchPages?: PagesSearch) {
	return async (query: string): Promise<PageLinkItem[]> =>
		((await searchPages?.(query)) ?? []).map((page) => ({
			id: page.id,
			title: page.title || 'Untitled',
			...(page.icon ? { icon: page.icon } : {})
		}));
}
