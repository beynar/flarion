/**
 * A deterministic stand-in for the text model, for tests and the development server (Workers AI is not available
 * locally). It reads the task line `buildWritePrompt` writes ("Task (<action>): ...") and the quoted document, and
 * streams a short answer word by word, so the streaming, suggestion and accept/reject flows run without any AI.
 */
import type { TextModel } from './client';

const WORDS = 1;

/** The reply the fake model gives for a prompt: `[AI <action>] ` and the first words of the quoted document. */
export function fakeReply(user: string): string {
	const action = /^Task \((\w+)\)/.exec(user)?.[1] ?? 'write';
	const quoted = /<<<BEGIN document [0-9a-f]+>>>\n([\s\S]*?)\n<<<END document [0-9a-f]+>>>/.exec(user)?.[1] ?? '';
	const head = quoted.trim().split(/\s+/).slice(0, 6).join(' ');
	switch (action) {
		case 'continue':
			return `and then the story went on, as drafted by the assistant. ${head ? `(after: ${head.slice(-30)})` : ''}`.trim();
		case 'summarize':
			return `Summary: ${head}.`;
		case 'fix_spelling':
			return quoted.replace(/teh/g, 'the');
		case 'translate':
			return `Traduction: ${head}`;
		case 'explain':
			return `In simple terms: ${head}.`;
		default:
			return `Improved: ${quoted.trim() || head}`;
	}
}

export const fakeTextModel: TextModel = async function* ({ messages }) {
	const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
	const words = fakeReply(user).split(/(\s+)/).filter(Boolean);
	for (let i = 0; i < words.length; i += WORDS * 2) {
		yield words.slice(i, i + WORDS * 2).join('');
		// A real model streams over time: yield to the event loop so tokens arrive as separate events.
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
};
