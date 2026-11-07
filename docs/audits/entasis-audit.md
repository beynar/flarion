# Entasis coverage audit (read-only)

Date: 2026-11-07. Library: `entasis@0.16.0` (`node_modules/entasis/dist`). Scope: every `.svelte` under `src/lib/components/**` and `src/routes/**` (111 files, `src/routes/(dev)/**` skipped). Nothing was edited. Line numbers are as of this audit; another agent is editing the repo, so re-grep before applying.

Docs were fetched from https://entasis.beynar.workers.dev/docs (index, `/docs/conventions`, `/components/select`, `/components/combobox`, `/components/table`, `/components/popup-menu`). Several component pages are thin (the docs site points at its MCP server for full pages), so the prop tables below come from the `.d.ts` / `*.props.d.ts` files in `dist`, which are authoritative.

## 0. Headline

- There is **no raw `<table>` anywhere**. The "tables" the owner saw are `<ul>/<li>` row layouts: grants in the share dialog, members/invites/passkeys/teamspaces in settings, members in the teamspace dialog, the trash popover, the history versions list.
- There are **24 native `<select>`** elements (12 files), **25 raw `<input>`** outside the editor (text, search, number, date, time, radio, file), 1 native radio group, **78 raw `<button>`** outside the editor, and 0 `entasis/tooltip` imports.
- The selects are concentrated in: filter builder (13), layout menu (4), settings members (2), teamspace settings dialog (2), shared `LevelSelect` (1, four call sites), share dialog (1 + `LevelSelect`), property label (1).
- The share dialog hand-rolls **tabs, a combobox/listbox, 2 selects, a table-like list, a read-only link input, an alert and skeletons**. Everything on it except Avatar, Button, Dialog and toast is custom.
- Already good (keep): `TrashPage` and `TableView` use `DataTable`; `BoardView` uses `Kanban`; `ListView`/`PropertiesMenu` use `SortableList`; `GalleryView` uses `Grid`+`Card`; `CalendarView`/`TimelineView` use `EventCalendar`/`GanttChart`; `ViewTabs` uses `Tabs`; `AppShell` uses `Sidebar`/`Confirmation`/`Breadcrumbs`; `CommandPalette` and the pickers use `Command`; `DateEditor` uses `CalendarPrimitive` + `Switch`; auth pages use `Alert`, `TextInput`, `Card`.

### Counts by category (findings in section 3)

| Category | Findings | Of which edytor chrome |
|---|---|---|
| Share dialog | 10 | 0 |
| Tables / row lists | 12 | 0 |
| Selects (native `<select>`) | 8 | 0 |
| Pickers / combobox | 5 | 0 |
| Menus / popovers built from buttons | 9 | 0 |
| Inputs (text, number, date, time, file, radio) | 9 | 0 |
| Tabs / segmented | 3 | 0 |
| Dialogs / confirmations | 2 | 0 |
| Chips, avatars, alerts, skeletons, tooltips, empty states, kbd, buttons | 11 | 0 |
| Editor, Flarion-owned (not edytor chrome) | 6 | 0 |
| Editor chrome (edytor controllers): verify feasibility | 11 | 11 |
| **Total** | **86** | **11** |

No entasis equivalent (section 5): 7 cases.

---

## 1. What entasis exports

`package.json` `exports` (all `types`/`svelte`/`default` map to `dist/components/<Name>/index.js`). Import path is the kebab-case export key. Icons are `entasis/icons/<camelName>` (for example `entasis/icons/plus`, used as `{@render plusIcon({ size: 14 })}` or as a `prefix={plusIcon}` value).

**Layout**: `aspect-ratio`, `card`, `grid`, `heading`, `resizable`, `scroll-area`, `separator`, `stack`, `app-shell`, `page-shell`, `sidebar`.
**Actions**: `button`, `button-group`, `segmented-control`, `toggle-button`, `toggle-button-group`, `toggle-menu`, `selection-menu`.
**Forms**: `field`, `form`, `multi-step-form`, `ask`, `text-input`, `text-area`, `number-input`, `password-input`, `phone-input`, `pin-input`, `date-input`, `date-selector`, `calendar` (exports `CalendarPrimitive`), `time-input`, `select`, `combobox`, `autocomplete`, `tags-input`, `tag-group`, `checkbox`, `checkboxes-input`, `radio-input`, `switch`, `slider`, `color-input`, `color-picker`, `file-input`, `key-value-input`, `json-editor`, `rating-input`, `rich-text-input`, `signature-input`, `voice-input`, `address-input`.
**Data display**: `avatar` (`Avatar`, `AvatarGroup`), `chip`, `kbd`, `table`, `data-table`, `tree`, `kanban`, `sortable-list`, `timeline`, `event-calendar`, `mini-calendar`, `gantt-chart`, `metadata-list`, `stat`, `rating`, `countdown`, `chart`, `address`.
**Feedback**: `alert`, `confirmation`, `empty`, `skeleton`, `spinner`, `spinner-text`, `progress`, `progress-circle`, `meter`, `network-indicator`, `toast`.
**Navigation**: `tabs`, `tabbar`, `breadcrumbs`, `command`, `navigation-menu`, `menu`, `menu-option`, `menu-bar`, `popup-menu`, `context-menu`, `pagination`, `stepper`, `accordion`, `collapsible`, `table-of-contents`.
**Overlays**: `dialog`, `popover`, `tooltip`, `hover-card`, `link-preview`, `floating-window`, `overlay`.
**Media / content**: `carousel`, `image-gallery`, `image-zoom`, `video-player`, `audio-player`, `media-volume`, `document-viewer`, `code`, `diff`, `markdown`, `mermaid`, `qr-code`, `map`, `globe`, `marquee`.
**Infra**: `theme`, `i18n`, `tailwind-plugin`, `cva`, `motion`, `scheduling`, `types`, `hitbox`, `slot`, `webmcp`, `spinner-overlay`, plus `ai-*` (chat, composer, thread, message, tool, ...).

### Props that matter for this app

Conventions (docs `/docs/conventions`): main collection is the top-level `items` prop; `value` / `defaultValue` / `bind:value` / `onValueChange`; overlays use `open` / `bind:open`; snippets are named for the part (`prefix`, `suffix`, `trigger`, `title`, `footer`, `actions`...); the `theme` prop takes part keys (`root`, `trigger`, ...).

| Component (import) | Key props | Notes |
|---|---|---|
| `Select` (`entasis/select`) | `items: (SelectOption{value,label,disabled} \| {label?,items})[]`, `value`/`onValueChange` (string \| null; array when `multiple`), `placeholder`, `size`, `density`, `separators`, `clearable`, `alignItemWithTrigger` (default true: opens over the trigger like a native select), `triggerAttrs` (native attrs on the trigger button: `aria-label`, `data-testid`), `label`, `description`, `labelPosition`, `disabled`, `readOnly`, `open`, `formatValue` | Options are `{value,label,disabled}` only: **no per-option snippet** (no icons, chips, descriptions). Rich options need `Combobox`. |
| `Combobox` (`entasis/combobox`) | `items: ComboboxItemsSource` (array, groups, or `(searchValue, {signal}) => items`, debounced, abortable), option `{value,label,description,disabled,data}`, `item` snippet, `searchValue` (bindable), `value`/`onValueChange({value,option})`, `filter`, `limit`, `autoHighlight`, `openOnFocus`, `showAllOnFocus`, `loading`, `getValueOption`, `noOptionsText`, `prefix` snippet, `placeholder` | Typed text is **not** a value; free text (an email) must be offered as a synthetic option. |
| `TagsInput` (`entasis/tags-input`) | same list props as Combobox, `value: string[]`, `onValueChange`, `customTags`, `maxTags`, `keepSearchOnSelect` | Multi-value pickers (multi-select, person, relation). |
| `Command` (`entasis/command`) | `items: {heading, items:{value,label,description,icon,shortcut,keywords,href,onSelect}[]}[]`, `bind:search`, `shouldFilter`, `autoHighlight`, `dialog`, `shortcut`, snippets `item`, `empty`, `footer` | Already used for pickers and the palette. |
| `Menu` / `PopupMenu` / `ContextMenu` | `Menu{items}`; items are `button` (ButtonProps), `option` (`title,description,prefix,suffix,color:'danger',selected,closeOnClick,onclick,href`), `separator`, `submenu{menu}`, `checkbox{value,onValueChange}`, `radio-group{value,onValueChange,items:[{value,title,...}]}`, `group{label,items}`; `filter` (search field), `header`/`footer`/`empty` snippets. `PopupMenu{menu, trigger, position, open, ref}`; `ContextMenu{items, children}` | `trigger` is a snippet (`{@attach popover.trigger}`), button props `{content, variant,...}` or `false` with `ref`. |
| `Popover` | `open`, `trigger` snippet / button props / `false`, `position`, `offset`, `modal`, `focusOnOpen`, `ref` (element or virtual element), `closeOnClickOutside`, `mobileSheet` | Fine for form-like content. Menus inside it should be `PopupMenu`. |
| `Dialog` | `open`, `type` (`modal`, `alert`, `fullScreen`, drawers), `size`, `closable`, snippets `title`, `description`, `footer`, `children` | |
| `Confirmation` + `confirmation()` | `confirmation({title, description, confirm:{text,color,...}, cancel, onConfirm})` returns `{confirmed, result}`; host `<Confirmation />` mounted in `AppShell` | One use today (`trash/confirm.ts`). |
| `Table` | `header: Record<col, string\|Snippet\|TableCell>`, `items: {cells: Record<col, ...>, class, selected}[]`, `caption`, `prefix`/`suffix` (toolbar, pager), `density` | **Rows have no attribute passthrough**: no `data-testid` / `data-*` per row. |
| `DataTable` | `items`, `columns: {id, accessor, header, cell, sortable, filter, editor:{type:'text'\|'number'\|'select'\|'date'\|'switch'\|'custom'}, width, align, resizable...}`, `getRowId`, `getRowAttrs`, `getCellAttrs`, `rowActions`, `onRowActivate`, `selectionMode`, `search`, `pagination`, `density`, `loading`, `empty`, `noResults`, `processingMode:'manual'`+`rowCount`, `onCellCommit`, `virtualize`, `sortableRows`/`onRowMove`, `state`/`onStateChange` | Has per-row attrs, row actions, inline editors, server-side mode. |
| `Tabs` / `Tabbar` | `Tabs{items:{value,label,prefix,suffix,href,disabled}[], value, onValueChange({value}), placement, tabbar:{size,variant:'underline'\|'pill',label}, children(payload)}`; `Tabbar` is the bar alone (supports `href` items, `variant`, `orientation`) | `TabItem` has no attrs passthrough (no per-tab `data-testid`). |
| `SegmentedControl` | `items:{value,label,icon,disabled}[]`, `value`, `onValueChange`, `variant:'normal'\|'pill'`, `size` | Binary / small enum toggles. |
| `RadioInput` | `items:{value,label,description,icon,disabled}[]`, `mode:'card'\|'normal'`, `bind:value` | |
| `Switch` / `Checkbox` | `value`/`onValueChange`, `size`, `inputAttrs`, `disabled`, `readOnly`; Checkbox also `indeterminate`, `mode` | |
| `TextInput` / `TextArea` / `NumberInput` | `value`, `onValueChange`, `label`, `placeholder`, `prefix`/`suffix` snippets, `inputAttrs`, `size`, `readOnly`; NumberInput `min,max,step,showControls,format,onValueCommit({value,reason})` | |
| `DateInput` / `DateSelector` / `TimeInput` / `CalendarPrimitive` | DateInput `value: Date`, `format`, `minDate`, `closeOnSelect`, `presets`; DateSelector `mode:'date'\|'range'\|'multiple'`; TimeInput `as:'minuteSinceMidnight'...`; Calendar `type:'calendar'\|'calendar-range'` | |
| `FileInput` | `mode:'single'\|'multiple'`, `value`, `onValueChange`, `types`, `maxSize`, `maxFiles`, `onReject`, `fileList` snippet | Dropzone + picker. |
| `Avatar` / `AvatarGroup` | Avatar `{name, src, size, prefix, suffix}`; AvatarGroup `{items:{name,src}[], max, size, avatar snippet, remainingCount snippet, theme}` | Initials fallback; no emoji. |
| `Chip` | `{color: semantic only, variant:'solid'\|'outline'\|'soft', size, selected, href, onclick, prefix, suffix, class, theme}` | `color` is `primary\|secondary\|danger\|success\|warning\|info\|neutral`: the 9 Notion option colors need a wrapper that sets CSS vars via `class`/`theme`. |
| `Tooltip` | `{trigger snippet \| ButtonProps, content, position, delay, hoverable, size}` | Button's `label` prop is only `aria-label`: icon-only buttons get no tooltip. |
| `Alert` | `{color, variant:'soft'\|'outline'\|'solid', size, dismissible, onDismiss, snippets prefix,title,description,children}` | |
| `Skeleton`, `Spinner`, `SpinnerText`, `Empty`, `Kbd` | `Empty{title,description,media,actions,mode:'normal'\|'card'}`, `Kbd{keys:(string\|Snippet)[]}`, `Spinner{size,variant,text}`, `Skeleton{class,children}` | |
| `Tree` | `paths: string[]` (file-path model), `dragAndDrop`, `renaming`, `onDropComplete`, `onRename`, context-menu surface, `icons`, `search` | Path-based, backed by `@pierre/trees`; not an id-based page tree (see section 5). |
| `Sidebar` | `tree?: SidebarTreeNode[]` (`label,icon,href,onclick,isActive,defaultOpen,children`), `headerMenu`, `footerMenu`, `content` snippet | Tree nodes have no DnD, rename, row actions or presence slot. |
| `Kanban`, `SortableList`, `Grid`, `Card`, `Breadcrumbs`, `Collapsible`, `Accordion`, `ToggleMenu`, `SelectionMenu` | as used today | `SelectionMenu` shows a `ToggleMenu` over the current text selection. |

---

## 2. Cross-cutting mapping rules

1. **Select vs. PopupMenu radio-group.** For a ghost "Can edit v" control with a destructive row ("Remove") under it, use `PopupMenu` with a `radio-group` plus a `separator` and a `danger` button item (Notion's own pattern). For a labelled form field, use `Select`.
2. **Select cannot render rich options.** Anything that needs an icon, an `OptionTag` or a description in the list is a `Combobox` (has `item` snippet) or `Command`, not a `Select`.
3. **Empty / null values.** `Select.value` is `string | null`. Replace `<option value="">None</option>` with an explicit item such as `{value: 'none', label: 'None'}` and map it at the boundary.
4. **Test ids.** Controls that carry `data-testid` today need these carriers: `Select` -> `triggerAttrs={{'data-testid': ...}}`; `TextInput`/`NumberInput` -> `inputAttrs`; `Switch`/`Checkbox` -> `inputAttrs`; `Button` -> spreads attrs; `DataTable` -> `getRowAttrs`/`getCellAttrs`; `Table` rows, `Tabs` tabs and `RadioInput` items have **no** attr hook, so tests must move to role/name locators there.
5. **Playwright impact.** `selectOption` is used 10 times in `tests/e2e/p2-gate.spec.ts`, `p3-gate.spec.ts`, `app/p2-app.spec.ts`, `app/p3-views.spec.ts` (for example `share-level`, `share-general`). Every `<select>` migration changes those to click-the-trigger + click-option (`getByRole('option', {name})`).
6. **Native `title=` tooltips** (non-editor: `TeamspacesTab.svelte:121`, `TopBar.svelte:150`, `TrashPage.svelte:83`, `PropertyValue.svelte:95`, `SidebarTree.svelte:333`) become `Tooltip`. The app imports `entasis/tooltip` nowhere.
7. **Delete after migration**: `filters/styles.ts` (`controlClass`, `ghostButtonClass`, `iconButtonClass` exist only to style native controls), `share/LevelSelect.svelte`'s `<style>`, the `.menu`/`.mitem`/`.item` CSS in `TableView`, `BoardView`, `ViewTabs`, `LayoutMenu`.

---

## 3. Findings

Priority: **P1** share dialog, **P2** tables/lists, **P3** selects and pickers, **P4** everything else. IDs are stable handles for follow-up work.

### 3.1 Share dialog (P1) `src/lib/components/share/`

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| SH-1 | `ShareDialog.svelte:157-172` | `role="tablist"` of two raw `<button role="tab">` (Share / Publish) with border-bottom styling | `Tabs` from `entasis/tabs` (or `Tabbar` from `entasis/tabbar` if the panels stay as `{#if tab}`) | `items=[{value:'share',label:'Share'},{value:'publish',label:'Publish'}]`, `bind`/`value`+`onValueChange={({value}) => tab = value}`, `tabbar={{size:'small', variant:'underline', label:'Share options'}}`. Panels go in the `children({item})` snippet. Tests use `share-tab`/`publish-tab` testids: `TabItem` has no attr hook, switch to `getByRole('tab', {name})`. |
| SH-2 | `ShareDialog.svelte:180-243` | Invite picker: `<input role="combobox">` + absolutely positioned `<ul role="listbox">` (`absolute top-full z-20`), `onblur` + `setTimeout(120)` hack, manual Enter/Escape, three row layouts (user / teamspace / email guest) | `Combobox` from `entasis/combobox` | `items={(q) => grouped(inviteSuggestions(q, ctx))}` returning `[{label:'People',items},{label:'Teamspaces',items},{label:'Invite by email',items:[{value:'email:'+q,label:'Invite '+q}]}]`; option `value` = `kind:id`, `data:{suggestion}` carries the `Suggestion`; `bind:searchValue={query}`; `item` snippet renders `Avatar` + name + right-aligned email/"Teamspace"/"Guest"; `filter={() => true}` (the filtering is already done by `inviteSuggestions`); `autoHighlight` replaces the "first suggestion on Enter" logic; `onValueChange({value, option})` sets `target = option.data.suggestion` then `invite()`; reset `value=null` after a successful invite. Typed-but-unmatched text becomes the synthetic email option, so `canShare && email regex` decides if it is offered. |
| SH-3 | `LevelSelect.svelte:25-38` (used at `ShareDialog.svelte:207`, `:299`, `TeamspaceSettingsDialog.svelte:177`, `CreateTeamspaceDialog.svelte:105`) | Native `<select>` with scoped CSS (`.level-select`), `extra` prop (unused anywhere) | Preferred in the share rows: `PopupMenu` (`entasis/popup-menu`) with a ghost small `Button` trigger showing `levelLabel(value)`; elsewhere (teamspace dialogs): `Select` (`entasis/select`) | Share rows: `menu.items=[{type:'radio-group', value, onValueChange:(v)=>onchange(v), items: LEVELS.map(l=>({value:l.value,title:l.label}))}, {type:'separator'}, {type:'button', children:'Remove', color:'danger', onclick}]` which also removes the separate remove button (SH-9). Forms: `Select items={LEVELS} size="small" alignItemWithTrigger={false} triggerAttrs={{'aria-label': label, 'data-testid': testid}} disabled`. Fixing the one component fixes 4 call sites. Test ids `share-level`, `share-invite-level`, `teamspace-settings-level`, `teamspace-default-level` need a new carrier (see rule 4). |
| SH-4 | `ShareDialog.svelte:260-321` | Grants "table": `<ul>/<li>` with four repeated row layouts (owner 262-269, teamspace default 272-279, grant rows 281-320, flex columns, `min-height: var(--app-table-row-height)`), `data-testid="share-grant-row"` / `data-subject` / `data-inherited` | `DataTable` from `entasis/data-table` (`density="compact"`, `pagination={false}`) | columns: `person` (cell snippet: `Avatar`/teamspace emoji + name + sublabel), `access` (SH-3 control, or static label for Owner / teamspace default / inherited rows), `actions` (via `rowActions`). One `items` array built from `[owner?, teamspaceDefault?, ...rows]` with a `kind` discriminator. `getRowAttrs={(r)=>({'data-testid':'share-grant-row','data-subject': r.subject,'data-inherited': String(r.inherited)})}`. `loading={loadState==='loading'}`, `empty` snippet. Use `DataTable`, not `Table`: `TableRow` cannot carry `data-testid`/`data-subject`, which tests (`p2-app.spec.ts:319`, `p2-gate.spec.ts:222`) rely on. |
| SH-5 | `ShareDialog.svelte:339-349` | "General access" native `<select>` (`share-general`) with a `''` option | `Select` (or `PopupMenu` as SH-3) | `items=[{value:'none',label:'Only people invited'}, ...LEVELS]`, `value={general?.level ?? 'none'}`, `onValueChange={(v)=>setGeneral(v==='none' ? '' : v)}`, `disabled={...}`, `triggerAttrs={{'data-testid':'share-general','aria-label':'General access'}}`. Can be the last row of the SH-4 table. |
| SH-6 | `ShareDialog.svelte:379-386` and `181-206` | Raw `<input readonly>` for the public link; raw `<input>` for invite | `TextInput` (`entasis/text-input`) with `readOnly`, and the Copy button in its `suffix` snippet | `<TextInput readOnly value={link} inputAttrs={{'aria-label':'Public link','data-testid':'publish-link', onfocus:(e)=>e.currentTarget.select()}}>{#snippet suffix()}<Button size="small" variant="ghost" prefix={copyIcon} onclick={copyLink} data-testid="publish-copy">Copy link</Button>{/snippet}</TextInput>`. (The invite input is covered by SH-2.) |
| SH-7 | `ShareDialog.svelte:174-176` | `<p role="alert">` styled with `--app-block-red-*` | `Alert` from `entasis/alert` | `<Alert color="danger" variant="soft" size="small" {@render prefix}>` exactly like the auth pages; keep `data-testid="share-error"` on a wrapper div (as `login/+page.svelte:57` does). |
| SH-8 | `ShareDialog.svelte:250-253` | `animate-pulse` placeholder divs | `Skeleton` from `entasis/skeleton` | `<Skeleton class="h-9 w-full" />` (or the DataTable `loading` state from SH-4). |
| SH-9 | `ShareDialog.svelte:306-318` | Raw `<button>` "remove" icon with hover classes and a spacer `<span>` | `Button` (`variant="ghost" size="small" prefix={xIcon} label=...`) or folded into SH-3's menu | Keep `data-testid="share-remove"` on the Button. |
| SH-10 | `ShareDialog.svelte:326-328, 356-358` | Icon tiles (`grid size-6/8 ... bg-hover`) and the emoji box `grid size-6` for teamspace icons (`:147, :230, :273`) | `Avatar` with `prefix` slot for icon tiles; the teamspace emoji has no entasis equivalent (Avatar is initials/image only) | Low value; leave the emoji span, convert the tiles if SH-4 lands. |

### 3.2 Tables and row lists (P2)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| TB-1 | `settings/MembersTab.svelte:119-141` | Members as `<ul>/<li>` flex rows (avatar, name, email, role `<select>`, Remove) | `DataTable` (`entasis/data-table`) | columns `member` (Avatar + name + "(you)"), `email` (`hidden md:` becomes column `class`), `role` (cell: `Select size="small"` bound to `setRole(member, v)` when `canManage && role !== 'owner' && userId !== self`, otherwise `Chip`), `actions` via `rowActions` (Remove `Button` ghost danger). Role cell alternative: `editor:{type:'select', options}` + `onCellCommit`, but the optimistic revert in `setRole` suits an in-cell `Select`. `getRowId={(m)=>m.userId}`, `loading`, `empty`. |
| TB-2 | `settings/MembersTab.svelte:143-155` | Pending invitations list | same `DataTable` (second instance) or a `Table` | columns email, role (`Chip`), expires, Revoke in `rowActions`. `data-testid="pending-invites"` on a wrapper. |
| TB-3 | `settings/MembersTab.svelte:98-107` | Role `<select>` with `<label>` in the invite form | `Select` | `label="Role"`, `items=ROLES.map(r=>({value:r,label:Capitalized}))`, `bind:value={role}`, same height as the sibling `TextInput` via `size`. |
| TB-4 | `settings/PasskeysTab.svelte:122-153` | Passkeys as `<ul>/<li>`, inline rename form swapped in (`editing === key.id`) | `DataTable` with `editor:{type:'text'}` on the name column | `onCellCommit={({row,value}) => rename(row.id, value)}` replaces `startRename`/`saveRename`/`editing`/`draft`; remove goes to `rowActions` (`disabled` when `passkeys.length<2`, keep its `label`); `empty` snippet replaces the `{:else}` li. |
| TB-5 | `settings/TeamspacesTab.svelte:91-133, 152-186` | Three `<ul>` lists (mine / browse / archived) built from a `row` snippet with fixed widths (`w-20`, `w-16`, `md:w-[176px]`) | `DataTable` (one per section; or one table with grouped rows) | columns teamspace (emoji + name + description/owners), members count, privacy (`Chip`), actions (`rowActions`: Join / Request access / Settings / Restore). `getRowAttrs` for `teamspace-row` / `archived-teamspace-row` testids. The "Request access" `<span title>` at `:121` becomes `Tooltip`. |
| TB-6 | `teamspaces/TeamspaceSettingsDialog.svelte:243-283` | Members `<ul>/<li>` with role `<select>` (`:255-265`) and Remove/Leave | `DataTable` or `Table` (compact, no pagination) | role -> `Select size="small"` (`disabled={lastOwner}`, items Owner/Member), Remove/Leave -> `rowActions`, role for non-managers -> `Chip`. Loading state at `:236-239` -> `Skeleton`/DataTable `loading`. |
| TB-7 | `trash/TrashPage.svelte:66-76, 104-117` (already `DataTable`) | Custom sort header `<button>` (`deletedHeader`) + sort glyph, a raw `<input type="search">`, a `Title / Date deleted` chip pair built from `<button>`s (`:114-117`) | Use `DataTable` natively | `sortable: true` on Name/Deleted columns with `processingMode="manual"` + `state`/`onStateChange` driving `list.setSort(...)` (deletes `deletedHeader` and the chip pair); `search={{placeholder:'Search trashed pages…', debounce:250}}` or `TextInput` + `prefix` icon for the search; the `title=` date tooltip at `:83` -> `Tooltip`; `empty` snippet -> `Empty`. |
| TB-8 | `trash/TrashPopover.svelte:55-82` | Raw `<input type="search">` (`:56`), `<ul>/<li>` result rows | `TextInput` + `Table`/`Command` | The search box -> `TextInput` (`prefix` magnifying glass). Rows keep their entasis `Button`s; list -> `Table` (compact, `header` omitted) or `Command` with `item` snippet. Loading/empty text -> `Spinner` / `Empty`. |
| TB-9 | `history/HistoryBody.svelte:136-155` (also `:100-103`) | Versions list: `<ul role="listbox">` of `<button data-selected>` with custom key handling (`history.keys`, `history.option(i)`); Unified / Side-by-side `Button` pair | `Command` (non-dialog) or `Menu` with `radio-group`; `SegmentedControl` for the diff style | Versions: `Command items=[{heading, items: versions.map(v=>({value:v.key,label:titleOf(v),description:authors(v)+' · '+time}))}]`, `value`/`onValueChange` replaces `history.select`, `showInput={false}`; this deletes the custom key navigation. Diff style: `SegmentedControl items=[{value:'unified',label:'Unified'},{value:'split',label:'Side by side'}]`. |
| TB-10 | `routes/(app)/[ws]/+page.svelte:63-77, 93-105` | Recent cards: raw `<a>` styled as cards; favorites: `<ul>` of `<a>` rows | `Card` with `href` (`entasis/card`, as `GalleryView` does), favorites -> `Menu` / `MenuOption as="a" href` (`entasis/menu-option`) | Cover strip stays a `background-image` div inside the Card. |
| TB-11 | `views/TableView.svelte:171-192, 224` (already `DataTable`) | Column header menu: `Popover` + hand-built `.menu`/`.mitem` buttons (Sort asc/desc/Hide); "New page" footer `<button class="add">` | `PopupMenu` for the menu; `Button` for the footer; consider native sort | Menu: `items=[{type:'option', title:'Sort ascending', prefix:sortAscendingIcon, disabled, onclick}, ..., {type:'option', title:'Hide', prefix: eyeSlashIcon}]`. Footer: `<Button variant="ghost" size="small" prefix={plusIcon}>New page</Button>`. The view sort is server-side: `DataTable processingMode="manual"` + `columns[].sortable` + `onStateChange` could replace the custom menu and caret; verify with virtualised windows. |
| TB-12 | `views/PropertiesMenu.svelte:46, 66, 78` | Raw search `<input class="search">`; raw eye `<button>`s inside `SortableList` rows; static "Hidden" rows | `TextInput`; `Button` (ghost icon) or `Switch`/`Checkbox` for shown/hidden | `SortableList` is correct and stays. Alternative: `Menu` with `checkbox` items plus `filter` for the search, but then the drag order is lost; keep `SortableList`. |

### 3.3 Selects (P3) native `<select>`

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| SL-1 | `filters/FilterConditionRow.svelte:35-50` | Property + operator `<select>` (`filter-prop`, `filter-op`), "Unknown property" fallback option | `Select` (property list can be long: `Combobox` if more than ~12 properties) | `items={api.filterable.map(d=>({value:d.id,label:d.name}))}` plus `{value: condition.prop, label:'Unknown property', disabled:true}` when `!def`; operators `ops.map(o=>({value:o.op,label:o.label}))`; `size="small"`, `triggerAttrs={{'data-testid':'filter-prop','aria-label':'Property'}}`, `disabled={api.readonly}`. |
| SL-2 | `filters/FilterGroupView.svelte:56-65` | And/Or `<select>` (`filter-group-kind`) | `Select` (or `SegmentedControl` with 2 items) | `items=[{value:'and',label:'And'},{value:'or',label:'Or'}]`. |
| SL-3 | `filters/SortEditor.svelte:40-63` | Sort property + direction `<select>`s, raw remove `<button>` (`:65`) | `Select` x2 (direction as `SegmentedControl` or an icon Select), `Button` | property items = `[current, ...unused]`; direction `[{asc,'Ascending'},{desc,'Descending'}]`. |
| SL-4 | `filters/GroupEditor.svelte:53-84` | Group-by, date bucket, sort-groups `<select>`s | `Select` x3 with `label` + `labelPosition="left"` | `none` sentinel for "None". `Switch` at `:90` is already entasis. `Show` button `:98` -> `Button`. |
| SL-5 | `filters/FilterValue.svelte:90-93, 163-170` | Boolean `<select>` (Checked/Unchecked) and date-range-mode `<select>` | `Select` (boolean could be `SegmentedControl`) | range items = `NAMED_RANGE_CHOICES` + `{value:'between',label:'Between…'}`. |
| SL-6 | `filters/DateOperandEditor.svelte:61-68, 89-97` | Mode, unit, direction `<select>`s | `Select` x3 | direction can be `SegmentedControl` (`ago` / `from now`). |
| SL-7 | `views/LayoutMenu.svelte:49-78` | Card preview / Card size / Date property / End date property native `<select>` with scoped CSS (`.opt select`) | `Select` with `label`, `labelPosition="left"`, `size="small"` | `''` options become `{value:'none'}` sentinels: "Page cover", "None (use the date's range)". Keep `data-testid` (`opt-cover`, `opt-size`, `opt-date`, `opt-end-date`) via `triggerAttrs`. |
| SL-8 | `teamspaces/TeamspaceSettingsDialog.svelte:161-170`; `properties/PropertyLabel.svelte:87-95` | Privacy `<select>`; number-format `<select>` | `Select` | Privacy: `items=PRIVACY_OPTIONS` (hint text stays in the sibling label; `Select` has no per-option description). Number format: `items=NUMBER_FORMATS`. |

(Role selects in `MembersTab` and `TeamspaceSettingsDialog`, and `LevelSelect`, are listed in 3.1 and 3.2.)

### 3.4 Pickers and combobox (P3)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| PK-1 | `teamspaces/TeamspaceSettingsDialog.svelte:190-234` | Add-member picker: same pattern as SH-2 (`role="combobox"` input, absolute `<ul role="listbox">`, blur timeout, Enter on `candidates[0]`) | `Combobox` | `items={candidates.map(c=>({value:c.userId,label:c.name,description:c.email}))}`, `item` snippet with `Avatar`, `bind:searchValue={query}`, `onValueChange={({value})=>{ if(value) add(value); }}` then `value=null`; share one `PersonCombobox` component with SH-2 if desired. |
| PK-2 | `editor/blocks/DatabaseViewBlock.svelte:98-120` | Database linker: raw `<input>` + `<ul>` of `<button>` results | `Combobox` with an async `items(query,{signal})` | Flarion-owned inline block (not edytor chrome). `getValueOption` not needed (one-shot pick). |
| PK-3 | `properties/SelectPicker.svelte:95-105` | Imports `Command` but rebuilds the footer: an "Edit options" `<button>` outside the Command; `OptionTag` per option | `Command`'s `footer` snippet; `Chip` | Move the button into `{#snippet footer()}` (as `CommandPalette` does) so it is inside the popup chrome; items use `Chip`/`OptionTag` (E-1). Keep `Command` (needs the "Create" row and custom `item` rendering). |
| PK-4 | `properties/PersonPicker.svelte`, `pickers/PagePicker.svelte`, `properties/AddProperty.svelte:122`, `pickers/IconPicker.svelte`, `page-header/IconPicker.svelte`, `shell/CommandPalette.svelte` | Not hand-rolled: entasis `Command`, correctly | Keep. Optional: `TagsInput` (`entasis/tags-input`) for multi-value person/relation/multi-select with chips in the cell | Listed so nobody "fixes" them. Duplicate: `pickers/IconPicker.svelte` and `page-header/IconPicker.svelte` are near-identical; keep one. |
| PK-5 | `filters/FilterValue.svelte:97-111, 126-139` | The reference-value trigger is a raw `<button class={triggerClass}>` styled with `controlClass`; the "Me" row is a raw `<button>` | `Button variant="outline" size="small"` as the Popover trigger; "Me" as a `Command` item in `PersonPicker` | `{@attach popover.trigger}` works on `Button`. Put "Me" in `PersonPicker`'s `items` as a first group, `onSelect` -> `onOp('is_me')`. |

### 3.5 Menus and popovers built from buttons (P3)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| MN-1 | `views/ViewTabs.svelte:107-144` | View options: `Popover` + `.item` buttons (Rename, Duplicate, Delete) with a two-click "Confirm delete" state, inline rename `<input>` (`:121`) | `PopupMenu` + `confirmation()` | `trigger` stays the existing `Button`; `items=[{type:'option',title:'Rename',prefix:pencilSimpleIcon},{type:'option',title:'Duplicate',prefix:copyIcon},{type:'separator'},{type:'option',title:'Delete view',prefix:trashIcon,color:'danger',disabled:views.length<2}]`; delete -> `confirmation({title:'Delete view?', confirm:{text:'Delete',color:'danger'}, onConfirm})` (deletes `confirmDelete`). Rename: keep a small `Popover` with `TextInput` (autofocus via `focusOnOpen`). |
| MN-2 | `views/ViewTabs.svelte:146-162` | Add-view menu: `Popover` + a `.heading` + `.item` buttons per layout | `PopupMenu` | `items=[{type:'group',label:'Add a view',items: VIEW_TYPE_ORDER.map(t=>({type:'option',title:VIEW_LABELS[t],prefix:VIEW_ICONS[t],onclick}))}]`. |
| MN-3 | `views/BoardView.svelte:130-145, 182, 187, 198` | Column "..." menu in a `Popover` with a raw `.mitem` button; raw `ibtn`, `more`, `new`, `hchip` buttons | `PopupMenu`; `Button`; `Chip` | Hide -> `{type:'option', title:'Hide', prefix:eyeSlashIcon}`. Add card / New / Load more -> `Button ghost size small`. Hidden-group chips -> `Chip onclick`. |
| MN-4 | `properties/PropertyLabel.svelte:51-121` | Popover with a raw name `<input>` (`:66`), raw delete `<button>` with "Click again to delete for everyone" (`:98-113`), static type row | `Popover` stays; `TextInput`, `Select`, `confirmation()` | Name -> `TextInput size="small" bind:value={draft}`; number format -> SL-8; delete -> `confirmation({...})` (replaces `confirming` state). |
| MN-5 | `views/LayoutMenu.svelte:31-40` | Layout type picker: 2-column grid of raw `<button class="type">` with check icon | `RadioInput mode="card"` or `Menu` with `radio-group` | `items=VIEW_TYPE_ORDER.map(t=>({value:t,label:VIEW_LABELS[t],icon:VIEW_ICONS[t]}))`, `value={env.view.type}`, `onValueChange={setType}`; the `layout-<type>` testids need role locators (RadioInput items have no attr hook) or keep as `Menu` option items with `attrs`. |
| MN-6 | `properties/OptionsEditor.svelte:55-170` | Options editor: back `<button>` (`:56`), accordion of `<button>` rows (`:73`), raw name `<input>` (`:93`), color swatches as `role="radio"` buttons (`:108-128`), raw delete `<button>`, raw add `<input>` + `<button type=submit>` (`:154-166`) | `Accordion`/`Collapsible` for the rows, `TextInput`, `Button`; swatches see section 5 | Row editing -> `Collapsible` per option; names -> `TextInput size="small"`; delete/add/back -> `Button`. The 9-color swatch radio group has only partial equivalents (`RadioInput` with `icon`, `TagGroup`); see NE-4. |
| MN-7 | `shell/MovePageDialog.svelte:45-56` | "Top level of" section list: raw `<button>` rows with icon | `Menu` (inline) | `<Menu items={sections.map(s=>({type:'option', title:s.label, prefix: s.key==='private'?lockIcon:emoji, onclick:()=>moveTo(s.target)}))}>`; keep `data-testid="move-section"` via option `attrs`. |
| MN-8 | `shell/SidebarTree.svelte:346-357, 329-343, 474-486, 500-508, 525-540` + `oncontextmenu` plumbing | Row `...`, `+`, section toggle raw `<button>`s; hand-written contextmenu handler feeding `PopupMenu` with a virtual `ref` | `Button` (ghost, 20px); `ContextMenu` | Row actions -> `Button variant="ghost" size="small" prefix={dotsThreeIcon} label=...` with `theme` for 20px; `entasis/context-menu` (`<ContextMenu items={...}>row</ContextMenu>`) replaces `contextMenu()`/`menuButton()`/`menuRef`. Medium risk: interplay with pragmatic-DnD handles on the same row; verify. The tree itself: NE-1. |
| MN-9 | `page-header/PageHeader.svelte:197-253` | Cover actions: seven raw `.chip` buttons; "Paste an image link" raw `<input>` + submit button (`:244-245`); upload via hidden `<input type=file>` (`:223`) + button | `Button variant="soft" size="small"`, `TextInput`, `FileInput` | `Popover` stays. Upload -> `FileInput mode="single" types={[...image mimes]} onValueChange={...}` (also gives drag-and-drop); URL -> `TextInput` with the `Add` button in its `suffix`. Preset swatches: NE-5. |

### 3.6 Inputs (P4 unless noted)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| IN-1 | `teamspaces/CreateTeamspaceDialog.svelte:83-98` | `<fieldset>` + raw `<input type="radio">` inside bordered `<label>` cards | `RadioInput mode="card"` | `<RadioInput label="Privacy" mode="card" items={PRIVACY_OPTIONS.map(p=>({value:p.value,label:p.label,description:p.hint}))} bind:value={privacy} />`. (P2-ish: it is a dialog the owner will see.) |
| IN-2 | `filters/FilterValue.svelte:70-77, 80-88` | Raw `<input type="text">` and `<input type="number">` | `TextInput`; `NumberInput` | `inputAttrs={{'aria-label':'Value'}}`; typing debounce is already in `FilterBuilder` (`typing=true`): use `onValueChange`; for number `onValueChange` / `onValueCommit`, `showControls={false}`. |
| IN-3 | `filters/DateOperandEditor.svelte:69-77, 79-88` | Raw `<input type="date">` and `<input type="number" min=1 max=1000>` | `DateInput`; `NumberInput` | `DateInput value={date} format="yyyy/mm/dd" onValueChange`; `NumberInput min={1} max={1000} showControls={false}`. |
| IN-4 | `properties/DateEditor.svelte:90-103, 96, 105, 133-141` | Two fake text fields (`<div class={field}>` showing the date), two raw `<input type="time">`, raw Clear `<button>` | `DateInput` (start/end), `TimeInput`, `Button` | The editor already uses `CalendarPrimitive` + `Switch`; replace the fake fields with `DateInput` (as `editor/blocks/DatePicker.svelte:76-91` already does), time with `TimeInput as="minuteSinceMidnight"` (convert to/from `HH:MM`), Clear with `Button variant="ghost"`. Consider merging `DateEditor` and `DatePicker.svelte` (duplicate logic). |
| IN-5 | `properties/PropertyEditor.svelte:170-187` | Inline editing `<input type=text/email/url/tel>` and `div role="button"` cell trigger (`:189-205`) | `TextInput size="small"` (+ `PhoneInput` for phone) | `inputAttrs={{'aria-label': def.name}}`; blur-commit / Enter / Escape stay in the wrapper. The cell trigger is a custom pattern (focusable div); acceptable, or use `Button variant="ghost"`. `NumberInput` and `Checkbox` here are already entasis. |
| IN-6 | `properties/FilesEditor.svelte:61-62` | Hidden `<input type="file" multiple>` + `Button` click proxy | `FileInput mode="multiple"` | `onValueChange={(files)=>picked(files)}`, `maxSize`, `onReject` for the error line; testid `file-input` via `fieldAttrs`/wrapper. |
| IN-7 | `properties/AddProperty.svelte:96-107` | Raw name `<input>` with autofocus attach; raw back `<button>` (`:92`); trigger `<button>` (`:73`) | `TextInput`, `Button` | Same as MN-4. |
| IN-8 | `views/ViewToolbar.svelte:97-106`, `views/PropertiesMenu.svelte:46`, `trash/TrashPage.svelte:104`, `trash/TrashPopover.svelte:56` | Four raw `<input type="search"/text>` with scoped or inline classes | `TextInput` with `prefix={magnifyingGlassIcon}` | One shared "SearchInput" wrapper would remove ~40 lines of repeated classes. |
| IN-9 | Inline rename and title inputs: `shell/SidebarTree.svelte:416-428`, `views/TitleCell.svelte:50-66`, `page-header/PageHeader.svelte:296-312` (title `<textarea>`), `views/ViewTabs.svelte:121` | Borderless in-place edit fields | `TextInput size="small"` with `theme` overrides, `TextArea` for the title | Verify: these are deliberately chrome-less in-place editors and rely on blur/Enter/Escape; entasis `TextInput` supports `theme` to strip borders, but the page title textarea (auto-grow, 40px) may be better left native. |

### 3.7 Tabs and segmented (P4)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| TG-1 | `routes/(app)/[ws]/settings/+layout.svelte:23-37` | Settings tab nav: `<nav>` of `<a>` with active classes | `Tabbar` (`entasis/tabbar`) with `href` items | `items=tabs.map(t=>({value:t.slug,label:t.label,href:`/${ws}/settings/${t.slug}`}))`, `value={current}`, `variant="pill"`, `label="Settings sections"`. `ready:false` ("API tokens") -> `disabled`. |
| TG-2 | `trash/TrashPage.svelte:114-117` | Sort toggle pair from raw `<button>`s | `SegmentedControl` | Superseded by TB-7 if column sorting is used. |
| TG-3 | `history/HistoryBody.svelte:100-103` | Unified / Side-by-side as two `Button` variants | `SegmentedControl` | See TB-9. |

### 3.8 Dialogs and confirmations (P4)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| DG-1 | `teamspaces/TeamspaceSettingsDialog.svelte:305-313` | Second `Dialog type="alert"` with hand-made Cancel/Archive footer buttons for "Archive teamspace" | `confirmation()` from `entasis/confirmation` (host already in `AppShell`) | `await confirmation({title:`Archive ${ts.name}?`, description, confirm:{text:'Archive teamspace',color:'danger','data-testid':'teamspace-archive-confirm'}, cancel:'Cancel', onConfirm: archive})`; removes `confirmOpen`, `busy` wiring. |
| DG-2 | `views/ViewTabs.svelte:134-136`, `properties/PropertyLabel.svelte:103-113` | "Click again to confirm" two-step buttons | `confirmation()` | See MN-1 and MN-4. |

### 3.9 Chips, avatars, alerts, skeletons, tooltips, empty states, kbd, buttons (P4)

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| MS-1 | `shell/OptionTag.svelte:8-13` (used in `MembersTab`, `TeamspacesTab`, `TeamspaceSettingsDialog`, `PropertyValue`, `SelectPicker`, `FilterValue`, `BoardView`) | Custom chip: `<span>` with `--app-option-<color>-bg/fg` | `Chip` (`entasis/chip`) as the single implementation | `<Chip variant="soft" size="small" class="..." style="--...">`: `Chip.color` only accepts semantic colors, so keep `OptionTag` as a 5-line wrapper that renders `Chip` and applies the `--app-option-*` vars through `class`/`theme.root`. Role/privacy tags (`roleColor`, privacy) can use real semantic colors (`primary`, `warning`, `success`, `neutral`). |
| MS-2 | `shell/PresenceAvatars.svelte:25-37` (used in `TopBar.svelte:125`, `SidebarTree.svelte:438`) | Hand-rolled avatar stack with initials, ring and overlap | `AvatarGroup` (`entasis/avatar`) | `<AvatarGroup items={users.map(u=>({name:u.name}))} {max} size="small">`; per-user color via the `avatar` snippet or `theme`; `PageHeader.svelte:289` already uses `AvatarGroup`, so presence is inconsistent. The 16px sidebar size needs a `theme` size override. |
| MS-3 | `shell/ReloadBanner.svelte:18-29` | Full-width `role="alert"` accent banner with a `Button` | `Alert` (`variant="solid" color="primary"`, `Button` in `children`) | Keeps `data-testid="app-banner"`. |
| MS-4 | `shell/TopBar.svelte:121-137, 148-153` | Offline/reconnecting pill (`<span role="status">`); lock indicator `<span title>` | `Chip` (`color="neutral" variant="soft" prefix={wifiSlashIcon}`); `Tooltip` | The pill is a chip; the lock icon becomes `Tooltip` around an icon `Chip`/`Button`. |
| MS-5 | `animate-pulse` placeholders: `settings/MembersTab.svelte:116`, `PasskeysTab.svelte:120`, `TeamspacesTab.svelte:148`, `shell/SidebarTree.svelte:493`, `trash/PageUnavailable.svelte:65`, `teamspaces/TeamspaceSettingsDialog.svelte:238`, `share/ShareDialog.svelte:252`, `routes/(app)/[ws]/[page]/+page.svelte:137-139`, `views/ViewHost.svelte:367,376` (`.skeleton`) | Ten hand-made skeletons | `Skeleton` (`entasis/skeleton`) | `<Skeleton class="h-9 w-full" />`; one shared `ListSkeleton` snippet. |
| MS-6 | Native `title=` tooltips (rule 6) | `title` attributes | `Tooltip` | `TeamspacesTab:121`, `TopBar:150`, `TrashPage:83`, `PropertyValue:95`, `SidebarTree:333`; editor-side: `DateMention.svelte:31`, `DatabaseViewBlock.svelte:82`. |
| MS-7 | Empty states: `trash/TrashPage.svelte:93-97`, `trash/PageUnavailable.svelte:53-72`, `routes/(app)/[ws]/+page.svelte:80-85`, `views/TableView.svelte:216-218` (`.empty`), `GalleryView`/`ListView` `.none`, list `{:else}` rows in `TeamspacesTab`, `PasskeysTab`, `FilesEditor` | Centered text blocks | `Empty` (`entasis/empty`) | `title`, `description`, `media` (icon/emoji), `actions=[{content:'Restore', onclick}]`. `PageUnavailable` maps to two `Empty` states with `actions`. |
| MS-8 | Loading text: `trash/TrashPopover.svelte:80`, `history/HistoryBody.svelte:130`, `shell/SidebarTree.svelte:458`, `trash/TrashPage.svelte:143` | Plain "Loading…" strings | `Spinner` / `SpinnerText` | Or `Button loading`. |
| MS-9 | `shell/CommandPalette.svelte:85-90` | "Up/Down Navigate, Enter Open, Esc Close" spans | `Kbd` (`entasis/kbd`) | `<Kbd keys={['Esc']} />` (the palette `footer` snippet already exists). |
| MS-10 | Raw `<button>` in non-editor files (78 total): `PageHeader` 11, `BoardView` 6, `SidebarTree` 6, `ViewTabs` 5, `TableView` 5, `OptionsEditor` 5, `TrashPage` 3, `ShareDialog` 3, `SortEditor` 3, `FilterGroupView` 3, others 1-2 each | Hand-styled buttons (`ghostButtonClass`, `.chip`, `.add`, `.mitem`) | `Button` (`entasis/button`, variants `solid/outline/soft/ghost`, `size`, `prefix`, `label`, `loading`) | Mostly resolved by the items above. Residual "New page" footers: `TableView.svelte:224`, `GalleryView.svelte:62`, `ListView.svelte:70`; "Try again": `ViewHost.svelte:364`; `PropertiesPanel.svelte` show/hide-empty toggles. |
| MS-11 | `views/ViewHost.svelte:360-374` | `.note role="alert"` blocks with a raw "Try again" button | `Alert` + `Button` | `<Alert color="danger" variant="soft">...<Button size="small" variant="ghost">Try again</Button></Alert>`. |

### 3.10 Editor, Flarion-owned (not edytor chrome) feasible now

These live under `src/lib/components/editor/**` but are Flarion's own DOM, not edytor controllers.

| ID | File:lines | Hand-rolled | Replace with | Mapping |
|---|---|---|---|---|
| ED-1 | `editor/Editor.svelte:137-162` | Banners (`flarion-editor-banner`, `role="status"/"alert"`) with inline `<button>`s: locked, AI unavailable, reload, denied, invalid, connect failed | `Alert` + `Button` | `color="warning"/"danger"/"info"`, `variant="soft"`, retry/reload as `Button size="small"` in `children`. Keep `data-testid`s. |
| ED-2 | `editor/blocks/DatePicker.svelte:96-135` | Raw `<input type="time">` x2, raw "Today" `<button>` | `TimeInput`, `Button` | Same as IN-4; shares logic with `properties/DateEditor.svelte`. |
| ED-3 | `editor/blocks/DateMention.svelte:31` | `title` attribute on the chip | `Tooltip` | The chip is an edytor inline block with `{@attach}`: `Tooltip trigger` snippet takes the attachment (`Snippet<[Attachment]>`), compatible. |
| ED-4 | `editor/blocks/DatabaseViewBlock.svelte:82, 98-120` | "Change" `<button class="link">`; picker input + list | `Button variant="ghost" size="small"`; `Combobox` (PK-2) | |
| ED-5 | `editor/blocks/BreadcrumbBlock.svelte:18-35` | Custom `<nav>` with `<a>` and `/` separators | `Breadcrumbs` (`entasis/breadcrumbs`, already used in `TopBar`) | `items=ancestors.map(a=>({label,href,onclick}))` (`BreadcrumbItem`); testids `breadcrumb-item`/`breadcrumb-current` need to move to a wrapper or be asserted by role. |
| ED-6 | `editor/EditorView.svelte:374-383` | Absolutely positioned floating "Comment" `<button>` at measured `top/left` | `SelectionMenu` (`entasis/selection-menu`) or `Popover ref={virtualElement}` + `Button` | `SelectionMenu` is built for "toolbar over the current text selection". Verify against edytor's selection ownership (feasibility), but if it works it deletes the manual positioning. |

### 3.11 Editor chrome (edytor controllers): verify feasibility

Per the Editor track decision, edytor's controllers attach keys, ARIA and `data-*` to the DOM (`{@attach controller.option(i)}`, `controller.popup`, `mousedown` preventDefault to keep editor focus). `editor/ui/Button.svelte` says so explicitly. Treat everything below as **"edytor chrome: verify feasibility"**; none of it should be changed without testing focus retention inside the editor.

| ID | File:lines | Hand-rolled | Candidate entasis component | Notes |
|---|---|---|---|---|
| EC-1 | `editor/ui/Kbd.svelte`, `editor/ui/Separator.svelte` | Custom `<kbd>` and `role="separator"` div | `Kbd` (`entasis/kbd`), `Separator` (`entasis/separator`) | Static, no controller attach, **likely safe**. Also `chrome/SuggestionBar.svelte:34,44` raw `<kbd>`. |
| EC-2 | `editor/ui/Button.svelte` (used by almost every chrome file) | Native `<button>` with cva variants | `Button` | `Button` is `WithAttachments`, so `{@attach}` should pass; the unknown is focus: a press must not move editor focus (`onmousedown preventDefault`). Verify before swapping. |
| EC-3 | `editor/ui/Input.svelte`, `ui/Textarea.svelte` (used in `FindBar`, `ImageToolbar`, `MediaEmpty`, `LanguageMenu`, `Toolbar`, `BlockMenu`, `SlashMenu`, `CommentCard`, `EquationPanel`) | Native inputs with classes | `TextInput` / `TextArea` | Controllers bind keys to the raw element; `inputAttrs` forwards attributes but not necessarily `{@attach}` on the inner `<input>`. Verify. |
| EC-4 | `chrome/Toolbar.svelte:40-180` | `role="toolbar"` with `role="menu"` panels (Write with AI, Turn into, Color) and menu-item buttons | `ToggleMenu` / `SelectionMenu` / `Menu` | Closest components exist; edytor drives open state and keyboard. Verify. |
| EC-5 | `chrome/BlockMenu.svelte:123-200` | Search `Input`, `role="menu"` rows, headings, separators | `Menu` (`filter`, `group`, `separator`) | `controller.popup` attach positions it. Verify. |
| EC-6 | `chrome/SlashMenu.svelte:42-110` | `role="combobox"` input + `role="listbox"` + grouped rows + footer `Kbd` | `Command` / `Menu` with `filter` | Keyboard and filtering owned by `SlashMenuController`. Verify. |
| EC-7 | `chrome/TriggerMenu.svelte:37-60`, `MentionMenu.svelte`, `PageLinkMenu.svelte`, `UrlPasteMenu.svelte:20` | `role="listbox"` option lists (mentions use entasis `Avatar` already) | `Menu` / `Command` | Same constraint as EC-6. |
| EC-8 | `chrome/LanguageMenu.svelte:16-45` | Search `Input` + list + `role="status"` empty text | `Combobox` / `Command` | Verify. |
| EC-9 | `chrome/FindBar.svelte:68-110` | Search/replace `Input`s + `Button`s, floating via `float.ts` (`gap: ({rects}) => ...`) | `TextInput`, `Button`, `Popover` | Positioning uses edytor's float helper; verify. |
| EC-10 | `chrome/EquationPanel.svelte:20-47`, `ImageToolbar.svelte:36-114`, `LinkCard.svelte:22`, `TableChrome.svelte`, `CodeHeader.svelte:28,41`, `BlockHandle.svelte`, `CommentCard.svelte:50`, `CommentsHeader.svelte`, `MediaEmpty.svelte:62-88` | Custom `role="dialog"` panel, absolutely positioned toolbars, raw buttons, raw `<input type=file>` (`MediaEmpty.svelte:82`), `Textarea` | `Popover`/`Dialog`, `Button`, `FileInput`, `TextArea` | `MediaEmpty` file input could be `FileInput`, but edytor's `MediaEmptyController` owns upload state. Verify. |
| EC-11 | `chrome/CalloutIcons.svelte:21-34` | Emoji/icon grid (`callout-icons-grid`, `--callout-icon-columns`) | none (see NE-3) | Command lists are not a grid. |

---

## 4. Already entasis (do not touch)

`trash/TrashPage.svelte` (DataTable, columns need the TB-7 clean-up), `views/TableView.svelte`, `BoardView` (Kanban), `ListView`/`PropertiesMenu` (SortableList), `GalleryView` (Grid, Card), `CalendarView`/`TimelineView`, `ViewTabs` (Tabs), `shell/AppShell.svelte` (Sidebar, Confirmation, Breadcrumbs, Theme), `shell/TopBar.svelte` (Button, PopupMenu, Breadcrumbs), `shell/CommandPalette.svelte` (Command), `trash/confirm.ts` (Confirmation), `history/HistoryPanel.svelte` (Dialog fullScreen) and the Diff in `HistoryBody`, `routes/(auth)/**` (Alert, Button, TextInput), `shell/AuthCard.svelte` (Card), `routes/+layout.svelte` (Theme, Toaster), `routes/(app)/[ws]/+layout.svelte` (NetworkIndicator, toast), toasts everywhere (`entasis/toast`, 13 imports).

## 5. No entasis equivalent (keep custom) and why

| ID | Where | Why |
|---|---|---|
| NE-1 | `shell/SidebarTree.svelte` + `shell/tree-dnd.ts` (page tree with drag-and-drop before/after/into, auto-expand on hover, lazy children, per-section drop targets, presence, inline rename, `treeitem` keyboard model) | `entasis/tree` is a path-string file tree (`paths: string[]`, backed by `@pierre/trees`): ids vs. titles as paths, lazily loaded children, three top-level sections, teamspace/shared/private roots and `store.canMove` legality do not map. `Sidebar.tree` (`SidebarTreeNode`) has no DnD, rename, row actions or presence slot. The code is already on pragmatic-drag-and-drop, the engine entasis lists use (file comment in `tree-dnd.ts`). Only the leaf controls (buttons, rename input, context menu) are replaceable, see MN-8, IN-9. |
| NE-2 | `page-header/PageHeader.svelte:160-193` cover reposition (pointer drag on a background image, `role="slider"` keyboard model, save/cancel) | No image-reposition or drag-pan component. `Slider` could replace the keyboard model only; the pointer gesture is bespoke. |
| NE-3 | `editor/chrome/CalloutIcons.svelte:21` emoji grid; `IconPicker` emoji list | `Command` is a list, not a grid; the app already uses `Command` with grouped emoji for pickers (acceptable). The callout grid belongs to the edytor controller (`picker.columns`). |
| NE-4 | `properties/OptionsEditor.svelte:108-128` and `OptionTag` (nine Notion option colors) | `Chip.color` / `TagGroup.color` take only the 7 semantic colors; `ColorPicker` is free-form. A swatch radio group over a fixed 9-color palette has no entasis component; only the surrounding controls are replaceable. |
| NE-5 | `page-header/PageHeader.svelte:208-220` cover preset swatches (gradient previews) | No swatch/gradient selector; closest `RadioInput` `icon` is not a preview tile. |
| NE-6 | Teamspace emoji as an avatar (`ShareDialog.svelte:147,230,273`, `TeamspacesTab`, sidebar) | `Avatar` renders image or initials only. |
| NE-7 | `Select` rich options (property options as colored tags in a closed dropdown) | `Select` items are `{value,label}` only; use `Command`/`Combobox` with `item` snippet (what the app already does). |

## 6. Suggested order of work

1. **Share dialog**: SH-3 first (one component, four call sites), then SH-1, SH-2, SH-4, SH-5, SH-6, SH-7, SH-8. Update `p2-gate.spec.ts:222`, `p2-app.spec.ts:319` (and the `share-tab`/`publish-tab` locators).
2. **Tables**: TB-1/TB-2/TB-3, TB-4, TB-5, TB-6, then TB-7/TB-8 and TB-9.
3. **Selects**: SL-1..SL-8 (delete `filters/styles.ts`), PK-1, IN-1, IN-2..IN-4.
4. **Menus**: MN-1..MN-5, MN-7, then DG-1/DG-2 and Confirmation.
5. **Everything else**: MS-1..MS-11, TG-1, ED-1..ED-6, then the editor chrome decisions (EC-*), starting with the zero-risk EC-1.
