/**
 * The AI slash commands (`/ai`): one command per action of `actions.ts`, in an "AI" group. They are enabled while the
 * page is writable and AI is not marked unavailable, so a down model removes them from the menu (the banner says why).
 */
import type { EditorCommand, Plugin } from 'edytor';
import { AI_ACTIONS, type AiSpec } from './actions.ts';
import { aiOffered } from './state.svelte.ts';

export interface AiPluginHost {
	run(spec: AiSpec): Promise<unknown>;
	readonly: () => boolean;
}

export function createAiPlugin(host: AiPluginHost): Plugin {
	return (edytor) => {
		const commands: EditorCommand[] = AI_ACTIONS.map((spec) => ({
			id: `ai.${spec.id}`,
			label: spec.label,
			icon: '✨',
			keywords: spec.keywords,
			group: 'AI',
			isEnabled: () => !host.readonly() && aiOffered() && Boolean(edytor.selection.caret ?? edytor.selection.projection.start),
			run: () => {
				if (host.readonly() || !aiOffered()) return false;
				// After the slash menu has taken its trigger text out of the block: the draft goes where the line now is.
				setTimeout(() => void host.run(spec), 0);
				return true;
			}
		}));
		return { commands };
	};
}
