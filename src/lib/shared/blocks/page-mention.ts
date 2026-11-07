/**
 * `@` mentions of pages share the people `mention` atom (`{ id, label }`): a page's id is prefixed so
 * the two never collide. The editor's `@` menu writes it, the indexing consumer reads it.
 */
export const PAGE_MENTION_PREFIX = 'page:';
