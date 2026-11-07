# P0 spike: design tokens, generated themes, static shell

Track: App UI and design. Date: 2026-11-07.

## Measurement status

Live DevTools measurement of a reference workspace is **still to be done**: no one on this track can
sign in to one. `src/lib/design/notion.tokens.ts` was seeded from the plan's tables and cross-checked
on 2026-11-07 against two public references. Each token carries `source`, `measuredAt` (the date it was
last checked against that source, not a live measurement) and `measured: false`. When a value is read
from the live app, set `measured: true` and update the date.

References: NotionKit 1.19.1 SKILL.md (chrome, metrics, shadows, tag colors) and matthiasfrank.de/en/notion-colors (block colors).

Where they disagree with the plan, the plan's value is kept (recorded in the token's `differs`):

| Token | Plan (kept) | Reference |
| --- | --- | --- |
| Secondary text, light | `#73726e` | NotionKit `#7d7a75` |
| Body text, light | `#2c2c2b` | matthiasfrank `#373530` |
| Body text, dark | `rgba(255,255,255,0.81)` | matthiasfrank `#D4D4D4` (same color, opaque; used as entasis `neutral`) |
| Accent, dark | `#2383e2` | NotionKit `#529CCA` |
| Callout panel, light | `#f9f8f7` | NotionKit `#f0efed` |
| Block text colors (brown, orange, yellow, green, blue, purple, pink) | plan table | NotionKit: e.g. orange `#d9730d`, blue `#337ea9` |
| Block backgrounds, light | plan table | NotionKit tints off by 1 to 3 hex steps (e.g. blue `#e7f3f8` vs `#E9F3F7`) |
| Cover height | about 30vh | NotionKit fixed 200px |

matthiasfrank's block colors match the plan's table exactly. Everything else (rows 28/36, buttons
28/24, inputs 32, tag 20px/3px, topbar 44, sidebar 260, hairlines, hover and active washes, menu shadow)
agrees between the plan and NotionKit.

## What the generator writes

`pnpm gen:theme` (`node --experimental-strip-types scripts/gen-theme.ts`, no extra dependency) writes to `src/lib/design/generated/`:

- `entasis-theme.css`: the two `@plugin 'entasis/tailwind-plugin/theme' { ... }` blocks.
- `edytor-overrides.css`: `html .edytor-notion { --notion-*; --edytor-color-*; --edytor-background-* ... }` and the same under `html[data-theme='dark'] .edytor-notion`.
- `app-vars.css`: `--app-*` variables, `--app-sidebar`, `--elevation-3/4/5`, `--color-surface`, `--row-height-sm/md`, option-tag and block colors.
- `design-tokens.ts`: `designTokens` for `<Theme designTokens>`.

`src/app.css` imports the first three after `@import 'tailwindcss'` and `@source '../node_modules/entasis/dist'`, and keeps the font `@theme` by hand (the generator fails if its stacks drift from the token file).

## Integration details that worked

```css
@plugin 'entasis/tailwind-plugin/theme' {
	name: light; default: true; colorscheme: light;
	surface: #ffffff; surface-recessed: #f9f8f7; surface-canvas: #ffffff; surface-raised: #ffffff; surface-floating: #ffffff;
	neutral: #2c2c2b; secondary: #f1f1ef; primary: #2383e2; primary-contrast: #ffffff; ...
	state-hover-opacity: 0.06; state-pressed-opacity: 0.09; state-selected-opacity: 0.08;
	radius: 0.75;
}
```

- `@plugin` works inside a file pulled in with `@import`. `radius: 0.75` gives `--radius-md` 0.375rem (6px) and `--radius-sm` 0.1875rem (3px).
- `typeScale` and `motion` are object valued and cannot go in a CSS block; they go in `designTokens`.
  `{ baseMinPx: 16, baseMaxPx: 16, scale: 'minorThird' }` gives a flat 16px base with `text-sm` = 14px and `text-xs` = 12px.
- Root layout: `<Theme designTokens={...}>` with `raisedWithBorder: false`, `defaultColor: 'neutral'`, `selectedColor: 'neutral'`, `focusColor: 'primary'`, `motion: { duration: { fast: 100, normal: 150 } }`, inside a `div.edytor-notion`.
- Theme switching: `useTheme()` returns the `ThemeState`; `theme.theme = 'dark' | 'light'`.
- Sidebar: `theme={{ panel: { base, variant: { admin } }, menuButton: { base: 'h-[var(--app-row-height)]' }, ... }}`. A plain arbitrary height overrides the compound `h-control-*` (rows measure 28px).
- Button heights: `setButtonTheme({ root: { size: { small: 'h-[var(--app-button-height-small)]', normal: 'h-[var(--app-button-height)]' } } })` in the root layout.
- `edytor/themes/notion.css` is imported from `app.css` (`@import 'edytor/themes/notion.css'`). Overrides use `html .edytor-notion` so they win whatever the import order.

Verified in Chromium (computed values): panel 248px, sidebar rows 28px, small buttons 24px, tag 20px with a 3px radius, property rows 34px, top bar 44px, page title 40px/700, document text 16px, `--color-surface` `#ffffff` / `#191919`, sidebar `#f9f8f7` / `#202020`, hover opacity 0.06 / 0.055, `--elevation-3` Notion's three layers, `--raised-border` off.

## Theme engine gaps and how they were closed

1. **Non-monotonic surfaces.** The whole surface ladder is passed explicitly (recessed = sidebar color, canvas = page, raised, floating), and `--app-sidebar` is published per theme and read through the Sidebar `theme` override.
2. **The base surface cannot be exact (found here, not in the plan).** entasis re-lightens the `surface` seed (white becomes `#fafafa`, `#191919` becomes about `#111113`). `app-vars.css` writes `--color-surface` directly.
3. **Exact shadows.** `--elevation-3`, `-4` and `-5` (dialogs use `raised-xl`) carry the menu shadow, and the dark tonal tints are set to `transparent`. The selector is `html[data-theme='dark']`, unlayered, so it beats both the plugin's base layer and `designTokens`.
4. **Row heights.** `--row-height-sm/md` are overridden to 28/36. Button heights (28/24) share `--control-height-*` with inputs (32), so buttons use a `theme` override.

## Other findings

- `$lib` no longer exists in SvelteKit 3. The repo uses `package.json` `"imports": { "#lib/*": "./src/lib/*" }`, with explicit extensions (`#lib/client/mock.ts`). This is a small additive edit to a shared file.
- `prefersDark: true` in a theme block emits `@media (prefers-color-scheme: dark){ rootBase html[data-theme=dark], rootBase .dark {...} }` (a literal `rootBase` selector, an entasis 0.16.0 bug). It matches nothing, so it is harmless: `<Theme>` already resolves the system scheme and sets `data-theme` before paint. Worth fixing upstream.
- The standalone entasis `Tree` is a path-based file tree on `@pierre/trees` (shadow DOM, string paths, no emoji icons), a poor fit for a page tree. The sidebar uses entasis `Sidebar`'s recursive `tree` groups instead. Drag to reorder and nest needs a decision in P1.
- edytor's Notion theme styles code syntax tokens with a light-only Prism palette; dark code highlighting still needs an override.
- The `Command` dialog backdrop is a blurred dark scrim; Notion uses a flat `rgba(15,15,15,0.6)`. A dialog `theme` override belongs in the component pass.
- Sidebar tree rows: leaf nodes have no chevron slot, so leaves and folders at the same depth do not align their icons as Notion's do.
- The built client has one 1.1 MB chunk (entasis, mostly); code splitting is for later.

## Not done in P0

Live measurement, the component pass (screenshot comparison per component), Playwright baselines for 20 screens, the computed-metrics test, a high-contrast setting, the upstream `notion` preset in entasis.
