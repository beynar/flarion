import type { DataTableThemeProps } from 'entasis/data-table';

/**
 * `theme` of the DataTables that stand in for Notion's plain lists (members, passkeys, teamspaces, grants,
 * trash). Styled through the table's own theme parts, never its private variables.
 *
 * - `columns` is a complete `grid-cols-[...]!` utility (a literal at the call site, so Tailwind sees it). DataTable
 *   sizes every column to a fixed pixel width and leaves the rest of the row empty, which truncated the title
 *   column ("Quarte..."): the `!` form wins over the inline template and lets one column take the free space.
 * - `edge`: `rows` keeps the hairlines between rows and above/below the list (a settings page); `none` removes the
 *   frame (inside a dialog or popover).
 * - `header: false` hides the header row visually (it stays for screen readers), as Notion's share rows have none.
 */
export function listTheme(options: { columns: string; edge?: 'rows' | 'none'; header?: boolean; rowClass?: string }): DataTableThemeProps {
	const { columns, edge = 'rows', header = true, rowClass = '' } = options;
	return {
		caption: { base: 'sr-only' },
		// The table is as wide as its host: the columns are sized by the grid template, not by their default 180 px.
		virtualTable: { base: 'w-full!' },
		stateRow: { base: 'min-h-20' },
		viewport: { base: edge === 'none' ? 'rounded-none border-0' : 'rounded-none border-x-0' },
		header: { base: header ? '' : 'sr-only' },
		headerRow: { base: columns },
		headerCell: { base: 'text-xs font-normal text-[color:var(--app-text-tertiary)]' },
		row: { base: `${columns} min-h-[var(--app-table-row-height)] ${rowClass}`.trim() }
	};
}
