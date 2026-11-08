/**
 * A deterministic stand-in for the text model of Ask AI, for tests and the development server (Workers AI is not
 * available locally). It reads the numbered excerpts `buildAskPrompt` quotes and answers from the first one, citing it
 * as `[1]`, so the sources event and the panel's citations run without any AI.
 */
import type { TextModel } from './client';

/** The reply the fake model gives for a prompt: the start of the first excerpt, cited. */
export function fakeAskReply(user: string): string {
	const excerpt = /<<<BEGIN excerpt 1 [0-9a-f]+>>>\n(?:Page: [^\n]*\n)?([\s\S]*?)\n<<<END excerpt 1 [0-9a-f]+>>>/.exec(user)?.[1];
	if (!excerpt) return "I couldn't find that in the pages you can access.";
	const head = excerpt.trim().split(/\s+/).slice(0, 24).join(' ');
	return `According to your pages: ${head} [1]`;
}

export const fakeAskModel: TextModel = async function* ({ messages }) {
	const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
	const words = fakeAskReply(user).split(/(\s+)/).filter(Boolean);
	for (let i = 0; i < words.length; i += 2) {
		yield words.slice(i, i + 2).join('');
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
};
