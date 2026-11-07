/**
 * The "Write with AI" actions of docs/PLAN.md "AI features": continue, summarize, improve, fix spelling, translate,
 * change tone and explain. One list drives the `/ai` slash commands and the selection toolbar's AI panel.
 */
import type { AI_WRITE_ACTIONS } from '#lib/shared/schemas.ts';

export type WriteAction = (typeof AI_WRITE_ACTIONS)[number];
export type Tone = 'professional' | 'casual' | 'straightforward' | 'confident' | 'friendly';

export interface AiSpec {
	/** Command id suffix (`ai.<id>`) and test id. */
	id: string;
	label: string;
	action: WriteAction;
	language?: string;
	tone?: Tone;
	keywords: string[];
	/** The draft replaces the selection (improve, fix, translate, tone), instead of following it (continue, summarize, explain). */
	replaces: boolean;
	/** Shown in the selection toolbar's panel (continue only makes sense at a caret, so it is slash-only). */
	toolbar: boolean;
}

const LANGUAGES = ['English', 'French', 'Spanish', 'German', 'Japanese'] as const;
const TONES: Tone[] = ['professional', 'casual', 'straightforward', 'confident', 'friendly'];
const title = (word: string) => word[0]!.toUpperCase() + word.slice(1);

export const AI_ACTIONS: readonly AiSpec[] = [
	{ id: 'continue', label: 'Continue writing', action: 'continue', keywords: ['ai', 'continue', 'write', 'draft', 'more'], replaces: false, toolbar: false },
	{ id: 'summarize', label: 'Summarize', action: 'summarize', keywords: ['ai', 'summarize', 'summary', 'tldr', 'shorten'], replaces: false, toolbar: true },
	{ id: 'improve', label: 'Improve writing', action: 'improve', keywords: ['ai', 'improve', 'rewrite', 'polish', 'better'], replaces: true, toolbar: true },
	{ id: 'fix_spelling', label: 'Fix spelling and grammar', action: 'fix_spelling', keywords: ['ai', 'fix', 'spelling', 'grammar', 'typo', 'proofread'], replaces: true, toolbar: true },
	{ id: 'explain', label: 'Explain this', action: 'explain', keywords: ['ai', 'explain', 'simplify', 'eli5'], replaces: false, toolbar: true },
	...LANGUAGES.map(
		(language): AiSpec => ({
			id: `translate_${language.toLowerCase()}`,
			label: `Translate to ${language}`,
			action: 'translate',
			language,
			keywords: ['ai', 'translate', 'translation', language.toLowerCase()],
			replaces: true,
			toolbar: true
		})
	),
	...TONES.map(
		(tone): AiSpec => ({
			id: `tone_${tone}`,
			label: `Change tone: ${title(tone)}`,
			action: 'change_tone',
			tone,
			keywords: ['ai', 'tone', 'change', 'rewrite', tone],
			replaces: true,
			toolbar: true
		})
	)
];

export const specById = (id: string): AiSpec | undefined => AI_ACTIONS.find((spec) => spec.id === id);
