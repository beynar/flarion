/**
 * Drag and drop for the sidebar tree, on Atlassian's pragmatic-drag-and-drop (the engine entasis's
 * own lists use; entasis does not export a tree adapter, so the package is a direct dependency).
 *
 * Every page row is a draggable and a drop target. Where the pointer sits on a row decides the drop:
 * the top quarter drops before it, the bottom quarter after it, the middle nests inside it. A section
 * header (a teamspace, Shared, Private) is a drop target for the end of that section's top level.
 * The pure geometry lives in `zoneAt` so it can be unit-tested; legality is the store's `canMove`.
 */
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

export type DropZone = 'before' | 'after' | 'into';

/** What a drop target says about itself while a page is dragged over it. */
export type DropTargetData =
	| { kind: 'row'; id: string; zone: DropZone }
	| { kind: 'section'; section: SectionRef };

export type SectionRef = { kind: 'teamspace'; id: string } | { kind: 'private' } | { kind: 'shared' };

const DRAG_KIND = 'flarion-page';

/** The drop zone for a pointer at `clientY` over a row spanning `top`..`top + height`. */
export function zoneAt(top: number, height: number, clientY: number): DropZone {
	const y = (clientY - top) / Math.max(1, height);
	if (y < 0.28) return 'before';
	if (y > 0.72) return 'after';
	return 'into';
}

export interface RowParams {
	id: string;
	onDragStart?: () => void;
	onDragEnd?: () => void;
}

/** Svelte action: a page row, draggable and a drop target with before, after and into zones. */
export function pageRow(node: HTMLElement, initial: RowParams) {
	let params = initial;
	const cleanup = combine(
		draggable({
			element: node,
			getInitialData: () => ({ kind: DRAG_KIND, id: params.id }),
			onDragStart: () => params.onDragStart?.(),
			onDrop: () => params.onDragEnd?.()
		}),
		dropTargetForElements({
			element: node,
			canDrop: ({ source }) => source.data.kind === DRAG_KIND,
			getData: ({ input, element }) => {
				const rect = element.getBoundingClientRect();
				return { kind: 'row', id: params.id, zone: zoneAt(rect.top, rect.height, input.clientY) } satisfies DropTargetData;
			}
		})
	);
	return {
		update(next: RowParams) {
			params = next;
		},
		destroy: cleanup
	};
}

/** Svelte action: a section header, a drop target for the end of the section's top level. */
export function sectionHeader(node: HTMLElement, initial: SectionRef) {
	let section = initial;
	const cleanup = dropTargetForElements({
		element: node,
		canDrop: ({ source }) => source.data.kind === DRAG_KIND,
		getData: () => ({ kind: 'section', section }) satisfies DropTargetData
	});
	return {
		update(next: SectionRef) {
			section = next;
		},
		destroy: cleanup
	};
}

export interface DragMonitor {
	/** The dragged page and the innermost target under the pointer (null: none). */
	onTarget(sourceId: string, target: DropTargetData | null): void;
	onDrop(sourceId: string, target: DropTargetData | null): void;
	onEnd(): void;
}

/** Watches every page drag; also scrolls `scroller` while the pointer nears its edges. */
export function watchTreeDrags(scroller: HTMLElement | null, monitor: DragMonitor): () => void {
	const read = (location: { current: { dropTargets: { data: Record<string | symbol, unknown> }[] } }) =>
		(location.current.dropTargets[0]?.data as unknown as DropTargetData | undefined) ?? null;
	const parts = [
		monitorForElements({
			canMonitor: ({ source }) => source.data.kind === DRAG_KIND,
			onDrag: ({ source, location }) => monitor.onTarget(source.data.id as string, read(location)),
			onDropTargetChange: ({ source, location }) => monitor.onTarget(source.data.id as string, read(location)),
			onDrop: ({ source, location }) => {
				monitor.onDrop(source.data.id as string, read(location));
				monitor.onEnd();
			}
		})
	];
	if (scroller) parts.push(autoScrollForElements({ element: scroller, canScroll: ({ source }) => source.data.kind === DRAG_KIND }));
	return combine(...parts);
}

/** The nearest ancestor that scrolls vertically (the sidebar's content area). */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
	let cur = el?.parentElement ?? null;
	while (cur) {
		const overflow = getComputedStyle(cur).overflowY;
		if (overflow === 'auto' || overflow === 'scroll') return cur;
		cur = cur.parentElement;
	}
	return null;
}
