# entasis — limitations hit while moving Flarion fully onto entasis (2026-11-08)

Candidates for upstream fixes in entasis (the app works around them today):

1. `DataTable` columns are fixed pixels — accept `1fr`/flex widths (a flexible title column needs a theme override today).
2. `DataTable`: starting an edit from a button inside a cell is cancelled by the document-click commit; no option to hide the header row.
3. `Combobox`: no `inputAttrs`/`triggerAttrs` (no `data-testid`/`aria-label`), does not open on click, option row shrink-wraps (`truncate` needs `w-0 min-w-full`), no free-text value.
4. `Select`: no per-option icon snippet; `labelPosition="left"` still renders the label above.
5. `Popover`: panel capped at 320px; portals to body and blurs a just-focused field.
6. `Tabs`, `SegmentedControl`, `Table` rows, `RadioInput` items: no per-item attributes (test ids).
7. `RadioInput mode="card"` pins the radio dot to `top-3`.
8. `DateInput`: no `aria-label` hook. `TextInput`/`Chip`/`Collapsible`: no input ref / role / aria passthrough.
9. `FileInput` defaults `types` to `['image/*']` (silently rejects other files).
10. `Chip.color` only takes the 7 semantic colors (Notion option palette has 9) — `OptionTag` themes it via `--app-option-*`.
11. `entasis/tree` is path-based (no id tree, lazy children, DnD, rename, row actions) — Flarion's sidebar tree stays custom on pragmatic-drag-and-drop.
12. No grid component for emoji pickers; no image-reposition component; no swatch/gradient selector.
13. Theme engine: `surface` seed is re-lightened (white → #fafafa); `prefersDark: true` emits an invalid `rootBase` selector (0.16.0).

edytor: `ToolbarController.anchor` returns an empty rect once the selection leaves the editor (toolbar jumps when its link field takes focus).
