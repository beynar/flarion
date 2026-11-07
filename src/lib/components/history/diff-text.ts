/**
 * The text two versions of a page are compared as: Markdown, one block per paragraph, so the line diff reads like the page.
 * `entasis/diff` takes two files of text; the version is the old one, the current page the new one.
 */
import { toMarkdown } from 'edytor/export';
import type { JSONDoc } from 'edytor/crdt/edytor';

export const markdownOf = (doc: JSONDoc | null | undefined): string => {
	if (!doc || !(doc.children ?? []).length) return '';
	try {
		return `${toMarkdown(doc).trimEnd()}\n`;
	} catch {
		return '';
	}
};

export const compareFiles = (version: JSONDoc | null, current: JSONDoc | null) =>
	[
		{ name: 'version.md', contents: markdownOf(version) },
		{ name: 'current.md', contents: markdownOf(current) }
	] as [{ name: string; contents: string }, { name: string; contents: string }];
