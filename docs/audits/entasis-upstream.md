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

## P4 component pass (2026-11-08)

Done while building quick find, the search page, the Ask AI panel, the accessibility fixes and the visual suite. `tests/visual/` photographs
20 screens in both themes at 100% zoom; `tests/visual/metrics.spec.ts` asserts the sizes the plan fixes (rows 28/36, property rows 34, buttons
24/28, inputs 32, tags 20 with 3px corners, controls 6px, panels 10px, 14/12/16/40px type, nesting 24px, sidebar 248px, top bar 44px) against
`src/lib/design/notion.tokens.ts`; `tests/visual/a11y.spec.ts` runs axe on the same screens. Notion itself was not available to compare
against, so "Notion's equivalent" is the plan's metrics and the token file. The test found, and the app now fixes, a table row of 37px (the cell
and the 1px row hairline both claimed 36), panels at 9px (`radius: 0.75` gives entasis' `lg` step 9px), and a section label at 14px.

**Fixed in the app (props, `theme` overrides, generated CSS)**
- `Command` rows: a custom `item` snippet carries the title, the breadcrumb path and the highlighted snippet (`description` is plain text on one line).
- `EventCalendar` header: the previous/next `ButtonGroup` leaves 23px hit areas (axe `target-size`); `theme={{ navigation }}` makes them 28px.
- `GanttChart` zoom control: its `Select` always shows the label "Zoom level" above the box; `theme={{ zoomControl }}` keeps it for screen readers only.
- `SortableList` with `disabled` (a view with a sort or a filter has no manual order) dims every row to 50% and shows `not-allowed`; the list view overrides both, because 50% text fails contrast and the rows are still links.
- `Combobox`: the default 20px magnifying-glass prefix is larger than Notion's 14-16px input icons; the share, teamspace and search inputs pass `prefix={false}`.
- Panels and menus are 10px: `--radius-lg` is written by `scripts/gen-theme.ts` at `html:root[data-theme]` (the runtime `<Theme designTokens>` style writes the same variable at `html[data-theme]` after the sheet loads and would win a tie).
- High-contrast setting: `--color-primary`, `--app-accent`, the secondary/tertiary text and the dark option-tag text are rewritten under `html[data-contrast='high']`.
- Sidebar rows keep their actions reachable on touch (`@media (hover: none)`), as `group-hover` never fires there.

**Gaps to fix upstream (entasis 0.16.0)**
14. `Command`: the highlight stays on the row it first landed on when the list above it changes (results arriving after typing). `autoHighlight` only re-runs when the list goes from empty to non-empty or the query changes, so Enter can land on the wrong row. The app lists nothing until the answer for the typed query is in. A re-anchor when `items` change identity, or an exposed `highlight()`, would let results stream in.
15. `Command` has no loading state (`aria-busy`); the `empty` snippet doubles as the loading row.
16. `AIThread` renders `source-url` citations as links only for `http(s)` URLs, in a new tab, and a `source-document` as plain text; an app that links citations to its own routes has to render them (the Ask panel does, in a `message` snippet).
17. `Chip` has no `data-slot`/`data-color`, so a test cannot tell an option tag from the outside except by `data-variant`.
18. `GanttChart` and `EventCalendar` have no `labels`/`showLabel` option for their inner `Select`, and `ButtonGroup` merges borders with a negative margin that shrinks small ghost buttons below the WCAG 2.5.8 target size.
19. `SortableList`: `disabled` conflates "cannot reorder" with "is inert"; a `reorderable={false}` that leaves the rows normal would remove the app's override.
20. Theme engine: `--color-primary` is an `oklab()` value and its `-readable`, `-dark` and `-muted` companions are separate variables, so a high-contrast mode that rewrites one leaves the others on the old hue; a `contrast: 'high'` token set in the engine would do it in one place.
21. `Tree`: no ARIA pattern for rows that hold buttons beside the item (axe `aria-required-children` on `role="tree"` with buttons in its rows). The sidebar's custom tree had the same finding and no longer does: each row is a `role="group"` that holds the buttons and the `role="treeitem"` link (with `aria-level` and `aria-expanded`), and `tests/visual/a11y.spec.ts` has no exception left.

edytor: a to-do's checkbox gets its `aria-label` a moment after the block renders (axe's `label` rule fails if it runs in that window; the visual suite waits 800ms). The exported HTML's checkbox has no accessible name (the published page adds one in `src/server/share/route.ts`, `nameCheckboxes`).

**Server rendering (SSR) of the app: what entasis 0.16.0 and edytor 7.0.4 needed (2026-11-08)**
Everything renders on the server now; these are the limits met, with what the app does about each.
22. `Theme` writes its boot `<script>` and token `<style>` with `{@html}`; the markup depends on the `nonce` prop. Rendered without it and then hydrated with one (a CSP nonce
    the Worker stamps afterwards), Svelte warns `hydration_html_changed` and keeps the server value. The app makes the nonce before the render (`hooks.server.ts`) and gives it
    to `<Theme nonce>` through page data, so both renders agree. Upstream: a way to ask `Theme` for the nonce itself (a context, or reading the request) would remove the hand-off.
23. The code and diff components (`@pierre/diffs`, `@pierre/highlights`, shiki) put every grammar and theme behind dynamic imports (about 320 modules, 14 MB in the server build),
    and `highlights` plus the inlined oniguruma WebAssembly add 600 KB; a Worker uploads every module and pays about 45 ms of start-up per MB. The app never highlights on the
    server, so `scripts/postbuild.mjs` empties the grammar and theme tables and the inlined wasm. Upstream: separate entry points (`entasis/code`) or a way to choose the languages
    and themes at build time, and keep the WebAssembly out of a bundle that does not use it.
24. `Sidebar` reads its resized width (`resizable.storageKey`, `localStorage`) when it mounts: a server render always draws the default width, so a person who resized it sees
    the sidebar change width after hydration. A cookie (or a prop for the initial width) would let the server draw it.
25. `DataTable` with `virtualize` draws `min(rows, viewport / rowHeight + overscan)` rows without a viewport, which is what makes its server render usable (the first screenful of rows);
    that works, but the rows are in the HTML only when `items` is set before the first render: a table fed through `$effect` (as the app's views did) renders no rows on the server.
26. edytor: `<Edytor snapshot={doc}>` server-renders a room-backed document natively (read-only, the plugins' own markup) and swaps in the live view in one update, which is what the
    app uses. Two things to know: the snapshot subtree is also a `[data-edytor]` with `role="textbox"` (a test or a script that looks for "the editor" must exclude
    `[data-edytor-snapshot]` or wait for `contenteditable="true"`), and a click or keystroke before the room answers lands on the read-only view and is lost.
