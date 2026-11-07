import { tableIcon } from 'entasis/icons/table';
import { kanbanIcon } from 'entasis/icons/kanban';
import { listBulletsIcon } from 'entasis/icons/listBullets';
import { squaresFourIcon } from 'entasis/icons/squaresFour';
import { calendarBlankIcon } from 'entasis/icons/calendarBlank';
import { chartBarHorizontalIcon } from 'entasis/icons/chartBarHorizontal';
import type { ViewType } from '#lib/shared/definitions.ts';

export const VIEW_ICONS: Record<ViewType, typeof tableIcon> = {
	table: tableIcon,
	board: kanbanIcon,
	list: listBulletsIcon,
	gallery: squaresFourIcon,
	calendar: calendarBlankIcon,
	timeline: chartBarHorizontalIcon
};

export const VIEW_LABELS: Record<ViewType, string> = {
	table: 'Table',
	board: 'Board',
	list: 'List',
	gallery: 'Gallery',
	calendar: 'Calendar',
	timeline: 'Timeline'
};

export const VIEW_TYPE_ORDER: readonly ViewType[] = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'];
