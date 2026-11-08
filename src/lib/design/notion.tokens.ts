/**
 * The single design token file for Flarion's "Notion-class" look.
 *
 * `scripts/gen-theme.ts` reads this file and writes, into `./generated/`:
 *   - entasis-theme.css    build-time `@plugin 'entasis/tailwind-plugin/theme'` blocks
 *   - edytor-overrides.css `--notion-*`, `--edytor-color-*` and `--edytor-background-*` per theme
 *   - app-vars.css         `--app-*` variables, the menu shadow, surface fixes, row heights
 *   - design-tokens.ts     the `<Theme designTokens>` map
 * Edit values here, run `pnpm gen:theme`, and all consumers follow.
 *
 * MEASUREMENT STATUS (read this before trusting a value)
 * Live DevTools measurement of a reference workspace is STILL TO BE DONE: nobody on this track can
 * sign in to one. Every value was seeded from `docs/PLAN.md` and cross-checked on 2026-11-07
 * against two public references:
 *   - NotionKit 1.19.1 SKILL.md (light and dark chrome values, metrics, shadows)
 *   - matthiasfrank.de/en/notion-colors (block text and background colors, both themes)
 * Where a reference disagrees with the plan, the plan's value is kept and the reference's value is
 * recorded in `differs`. Each token carries a `source` and a `measuredAt` date. `measuredAt` is
 * the date the value was last checked against a source, NOT the date of a live measurement; no
 * token has `measured: true` yet. Flip that flag, and update the date, when a value is read from
 * the live app.
 */

export const MEASURED_AT = '2026-11-07';

export type Source =
	| 'plan' // docs/PLAN.md seed value, not contradicted by a reference
	| 'plan+notionkit' // plan value, confirmed by NotionKit
	| 'plan+matthiasfrank' // plan value, confirmed by matthiasfrank.de
	| 'plan+notionkit+matthiasfrank'
	| 'notionkit' // value taken from NotionKit because the plan has none
	| 'edytor' // edytor's own Notion theme default
	| 'derived'; // computed or chosen by this file to fill a theme-engine gap

export type Meta = {
	source: Source;
	/** Date the value was last checked against `source`. */
	measuredAt: string;
	/** True only once the value was read from the live reference app with DevTools. */
	measured: boolean;
	/** Values the other references give, when they disagree with the kept value. */
	differs?: Record<string, string>;
	note?: string;
};

export type ThemedToken<T = string> = Meta & { light: T; dark: T };
export type ValueToken<T = string | number> = Meta & { value: T };

const meta = (source: Source, extra: Partial<Meta> = {}): Meta => ({
	source,
	measuredAt: MEASURED_AT,
	measured: false,
	...extra
});
const themed = <T = string>(
	light: T,
	dark: T,
	source: Source,
	extra: Partial<Meta> = {}
): ThemedToken<T> => ({ light, dark, ...meta(source, extra) });
const value = <T extends string | number>(
	v: T,
	source: Source,
	extra: Partial<Meta> = {}
): ValueToken<T> => ({ value: v, ...meta(source, extra) });

/* ------------------------------------------------------------------------------------------ */
/* Core tokens                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const core = {
	page: themed('#ffffff', '#191919', 'plan+notionkit+matthiasfrank'),
	sidebar: themed('#f9f8f7', '#202020', 'plan+notionkit'),
	text: themed('#2c2c2b', 'rgba(255, 255, 255, 0.81)', 'plan+notionkit', {
		differs: { 'matthiasfrank light': '#373530', 'matthiasfrank dark': '#D4D4D4 (opaque)' },
		note: 'Dark text is the 0.81 white wash; entasis needs an opaque seed, see entasis.dark.neutral.'
	}),
	textSecondary: themed('#73726e', 'rgba(255, 255, 255, 0.46)', 'plan', {
		differs: { 'notionkit light': '#7d7a75' },
		note: 'Plan value kept: slightly below WCAG AA on white. A high-contrast setting is planned.'
	}),
	textTertiary: themed('#91918e', 'rgba(255, 255, 255, 0.32)', 'plan+notionkit'),
	textSidebar: themed('#5f5e5b', 'rgba(255, 255, 255, 0.62)', 'plan+notionkit'),
	hairline: themed('rgba(28, 19, 1, 0.11)', 'rgba(255, 255, 255, 0.094)', 'plan+notionkit'),
	hairlineStrong: themed('rgba(27, 21, 0, 0.19)', 'rgba(255, 255, 255, 0.16)', 'notionkit'),
	hoverWash: themed('rgba(55, 53, 47, 0.06)', 'rgba(255, 255, 255, 0.055)', 'plan+notionkit'),
	activeRow: themed('rgba(55, 53, 47, 0.08)', 'rgba(255, 255, 255, 0.08)', 'plan+notionkit'),
	inputFill: themed('rgba(242, 241, 238, 0.6)', 'rgba(255, 255, 255, 0.055)', 'notionkit'),
	accent: themed('#2383e2', '#2383e2', 'plan', {
		differs: { 'notionkit dark': '#529CCA' },
		note: 'Plan keeps one blue in both themes.'
	}),
	// Text selection is 0.28 in light; the plan says "measure" for dark, so the light value is
	// reused until it is measured.
	textSelection: themed('rgba(35, 131, 226, 0.28)', 'rgba(35, 131, 226, 0.28)', 'plan', {
		note: 'Dark value unmeasured: plan says "measure"; light value reused.'
	}),
	blockSelection: themed('rgba(35, 131, 226, 0.14)', 'rgba(35, 131, 226, 0.14)', 'plan'),
	danger: themed('#cd3c3a', '#df5452', 'plan+notionkit'),
	calloutPanel: themed('#f9f8f7', '#252525', 'plan', {
		differs: { 'notionkit light': '#f0efed' }
	}),
	codePanel: themed('#f7f6f3', '#202020', 'plan+notionkit'),
	inlineCode: themed('#cf5148', '#df5452', 'edytor', {
		note: 'Light is edytor default. Dark reuses the danger red until measured.'
	}),
	scrim: themed('rgba(15, 15, 15, 0.6)', 'rgba(15, 15, 15, 0.6)', 'notionkit'),
	// Surfaces the entasis ladder needs (see the "non-monotonic surfaces" gap in gen-theme.ts).
	surfaceRaised: themed('#ffffff', '#202020', 'derived', {
		note: 'NotionKit --nk-bg-card. Cards and raised panels.'
	}),
	surfaceFloating: themed('#ffffff', '#252525', 'derived', {
		note: 'Menus, popovers, dialogs. Dark uses the callout panel value; to be measured.'
	})
} as const;

/**
 * The high-contrast setting (Settings > Appearance, or the OS's `prefers-contrast: more`): Notion's secondary and
 * tertiary text sit at or under WCAG AA (4.5:1) on the page and the gray panels, so by default they stay as Notion has
 * them, and this setting swaps in values that keep 4.5:1 on every surface the app uses (page, sidebar, hover and
 * active washes, callout and code panels, the gray block background). Ratios are checked by tests/unit/design-contrast.test.ts.
 */
const highContrast = {
	textSecondary: themed('#55544f', 'rgba(255, 255, 255, 0.70)', 'derived', {
		note: 'Default is #73726e / 0.46 white: 4.3:1 on the gray panels, 4.0:1 in dark.'
	}),
	textTertiary: themed('#6a6965', 'rgba(255, 255, 255, 0.58)', 'derived', {
		note: 'Default is #91918e / 0.32 white: about 3:1, below AA.'
	}),
	textSidebar: themed('#4b4a47', 'rgba(255, 255, 255, 0.78)', 'derived'),
	/** Blue text (links, active toolbar buttons) on the page: #2383e2 is 3.9:1 on white, so light uses a deeper blue and dark a lighter one. */
	accent: themed('#1a6dc0', '#5aa9ff', 'derived'),
	/** The fill of primary buttons, which carry white text: 5.3:1 (the default #2383e2 gives 3.9:1). */
	primaryFill: value('#1a6dc0', 'derived'),
	/** Option tags in dark mode: full white on the stronger palette (the 0.85 white of the default is 4.4:1 on yellow). */
	optionTextDark: value('#ffffff', 'derived')
} as const;

/** Notion's three-layer floating-surface shadow. */
const shadows = {
	menu: themed(
		'rgba(15, 15, 15, 0.05) 0 0 0 1px, rgba(15, 15, 15, 0.1) 0 3px 6px, rgba(15, 15, 15, 0.2) 0 9px 24px',
		'rgba(15, 15, 15, 0.2) 0 0 0 1px, rgba(15, 15, 15, 0.4) 0 3px 6px, rgba(15, 15, 15, 0.6) 0 9px 24px',
		'plan+notionkit'
	),
	card: themed('0 1px 2px rgba(0, 0, 0, 0.04)', 'none', 'notionkit'),
	button: themed(
		'inset 0 0 0 1px rgba(15, 15, 15, 0.1), 0 1px 2px rgba(15, 15, 15, 0.1)',
		'inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 1px 2px rgba(0, 0, 0, 0.3)',
		'notionkit'
	)
} as const;

/* ------------------------------------------------------------------------------------------ */
/* Block colors (text and background, as Notion's color menu applies them)                    */
/* ------------------------------------------------------------------------------------------ */

export const blockColorNames = [
	'gray',
	'brown',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink',
	'red'
] as const;
export type BlockColorName = (typeof blockColorNames)[number];

export type BlockColor = {
	text: { light: string; dark: string };
	background: { light: string; dark: string };
} & Meta;

const bc = (
	textLight: string,
	bgLight: string,
	textDark: string,
	bgDark: string,
	extra: Partial<Meta> = {}
): BlockColor => ({
	text: { light: textLight, dark: textDark },
	background: { light: bgLight, dark: bgDark },
	...meta('plan+matthiasfrank', extra)
});

/** The plan's table. matthiasfrank.de matches it exactly; NotionKit differs, see `differs`. */
const blockColors: Record<BlockColorName, BlockColor> = {
	gray: bc('#787774', '#F1F1EF', '#9B9B9B', '#252525', {
		differs: { 'notionkit tint light/dark': '#f1f1ef / #252525 (same)' }
	}),
	brown: bc('#976D57', '#F3EEEE', '#A27763', '#2E2724', {
		differs: { 'notionkit text': '#9f6b53 / #ba856f', 'notionkit tint': '#f4eeee' }
	}),
	orange: bc('#CC782F', '#F8ECDF', '#CB7B37', '#36291F', {
		differs: { 'notionkit text': '#d9730d / #c77d48', 'notionkit tint light': '#fbecdd' }
	}),
	yellow: bc('#C29343', '#FAF3DD', '#C19138', '#372E20', {
		differs: { 'notionkit text': '#cb912f / #ca8f3d', 'notionkit tint light': '#fbf3db' }
	}),
	green: bc('#548164', '#EEF3ED', '#4F9768', '#242B26', {
		differs: { 'notionkit text': '#448361 / #529e72', 'notionkit tint light': '#edf3ec' }
	}),
	blue: bc('#487CA5', '#E9F3F7', '#447ACB', '#1F282D', {
		differs: { 'notionkit text': '#337ea9 / #5e87c9', 'notionkit tint light': '#e7f3f8' }
	}),
	purple: bc('#8A67AB', '#F6F3F8', '#865DBB', '#2A2430', {
		differs: { 'notionkit text': '#9065b0 / #9d68d3', 'notionkit tint light': '#f8f3fc' }
	}),
	pink: bc('#B35488', '#F9F2F5', '#BA4A78', '#2E2328', {
		differs: { 'notionkit text': '#c14c8a / #d15796', 'notionkit tint light': '#fcf1f6' }
	}),
	red: bc('#C4554D', '#FAECEC', '#BE524B', '#332523', {
		differs: { 'notionkit text': '#cd3c3a / #df5452', 'notionkit tint light': '#fdebec' }
	})
};

/* ------------------------------------------------------------------------------------------ */
/* Select and status option palette (stronger than the block colors)                          */
/* ------------------------------------------------------------------------------------------ */

export type OptionColor = {
	background: { light: string; dark: string };
	text: { light: string; dark: string };
} & Meta;

const oc = (bgLight: string, textLight: string, bgDark: string): OptionColor => ({
	background: { light: bgLight, dark: bgDark },
	text: { light: textLight, dark: 'rgba(255, 255, 255, 0.85)' },
	// The plan names only light gray #e3e2e0 and light red #ffe2dd; the rest are NotionKit's.
	...meta('notionkit', {
		note: 'Plan fixes light gray and light red (both match); other entries come from NotionKit.'
	})
});

const optionColors: Record<BlockColorName, OptionColor> = {
	gray: oc('#e3e2e0', '#32302c', '#373737'),
	brown: oc('#eee0da', '#442a1e', '#603b2c'),
	orange: oc('#fadec9', '#49290e', '#854c1d'),
	yellow: oc('#fdecc8', '#402c1b', '#89632a'),
	green: oc('#dbeddb', '#1c3829', '#2b593f'),
	blue: oc('#d3e5ef', '#183347', '#28456c'),
	purple: oc('#e8deee', '#412454', '#492f64'),
	pink: oc('#f5e0e9', '#4c2337', '#69314c'),
	red: oc('#ffe2dd', '#5d1715', '#6e3630')
};

/* ------------------------------------------------------------------------------------------ */
/* Type                                                                                        */
/* ------------------------------------------------------------------------------------------ */

const type = {
	fonts: {
		sans: value(
			'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"',
			'plan'
		),
		mono: value('"SFMono-Regular", Menlo, Consolas, monospace', 'plan'),
		/** Per-page Serif style: a Georgia-based stack, not a licensed font. */
		serif: value('Georgia, "Times New Roman", Times, serif', 'plan'),
		/** Per-page Mono style: a plain monospace stack. */
		pageMono: value('ui-monospace, "SF Mono", Menlo, Consolas, monospace', 'plan')
	},
	/** Pixel sizes. */
	sizes: {
		chrome: value(14, 'plan+notionkit'),
		small: value(12, 'plan'),
		document: value(16, 'plan'),
		documentSmall: value(14, 'notionkit', { note: 'Notion\'s per-page "Small text" option.' }),
		pageTitle: value(40, 'plan+notionkit')
	},
	lineHeight: { document: value(1.5, 'plan'), title: value(1.2, 'edytor') },
	/** Heading sizes in em, weight 600; page title weight 700. */
	headings: {
		h1: value(1.875, 'plan'),
		h2: value(1.5, 'plan'),
		h3: value(1.25, 'plan'),
		weight: value(600, 'plan'),
		titleWeight: value(700, 'plan')
	}
} as const;

/* ------------------------------------------------------------------------------------------ */
/* Metrics (pixels unless stated)                                                              */
/* ------------------------------------------------------------------------------------------ */

const metrics = {
	/** Sidebar: 240 to 260 by default; the user can drag out to `resizeMax`. */
	sidebar: {
		min: value(240, 'plan'),
		default: value(248, 'derived', { note: 'Between the plan\'s 240 and 260; NotionKit uses 260.' }),
		max: value(260, 'plan+notionkit'),
		resizeMax: value(420, 'derived', {
			note: 'Drag limit. The plan range is the default band; a 20px drag would be useless.'
		})
	},
	topbar: value(44, 'plan+notionkit'),
	row: value(28, 'plan+notionkit', { note: 'Sidebar and menu rows.' }),
	tableRow: value(36, 'plan+notionkit'),
	propertyRow: value(34, 'plan'),
	button: value(28, 'plan+notionkit'),
	buttonSmall: value(24, 'plan+notionkit'),
	input: value(32, 'plan+notionkit'),
	tagHeight: value(20, 'plan+notionkit'),
	tagRadius: value(3, 'plan+notionkit'),
	nestStep: value(24, 'plan'),
	/** Cover height as a viewport share; NotionKit uses a fixed 200px. */
	coverVh: value(30, 'plan', { differs: { notionkit: '200px' } }),
	coverMin: value(180, 'derived'),
	pageColumn: value(708, 'plan', {
		note: 'Default content width; the plan says 708 to 760 (measure). NotionKit max is 760.'
	}),
	pageColumnWide: value(760, 'plan+notionkit'),
	pagePaddingX: value(96, 'derived', { note: 'Notion default: 900 total minus 708 column. Measure.' }),
	pagePaddingXNarrow: value(24, 'notionkit'),
	narrowBreakpoint: value(860, 'notionkit'),
	icon: value(20, 'derived'),
	pageIconLarge: value(78, 'derived', { note: 'Header page icon; Notion uses 78px. Measure.' })
} as const;

const radii = {
	control: value(6, 'plan+notionkit'),
	panel: value(10, 'plan+notionkit'),
	card: value(8, 'notionkit'),
	tag: value(3, 'plan+notionkit')
} as const;

const motion = {
	fast: value(100, 'plan'),
	normal: value(150, 'plan')
} as const;

/* ------------------------------------------------------------------------------------------ */
/* entasis theme engine seeds (the `@plugin` block values)                                     */
/* ------------------------------------------------------------------------------------------ */

const entasis = {
	/** `radius: 0.75` makes `md` 6px (controls) and `sm` 3px (tags). */
	radius: 0.75,
	/** Base type size in px, the same at every viewport width. A minorThird ramp gives sm 14, xs 12. */
	typeScale: { baseMinPx: 16, baseMaxPx: 16, scale: 'minorThird' },
	stateOpacity: {
		light: { hover: 0.06, pressed: 0.09, selected: 0.08 },
		dark: { hover: 0.055, pressed: 0.08, selected: 0.08 }
	},
	light: {
		surface: '#ffffff',
		neutral: '#2c2c2b',
		secondary: '#f1f1ef',
		primary: '#2383e2',
		'primary-contrast': '#ffffff',
		info: '#2383e2',
		danger: '#cd3c3a',
		'danger-contrast': '#ffffff',
		success: '#448361',
		warning: '#cb912f'
	},
	dark: {
		surface: '#191919',
		neutral: '#d4d4d4',
		secondary: '#252525',
		primary: '#2383e2',
		'primary-contrast': '#ffffff',
		info: '#2383e2',
		danger: '#df5452',
		'danger-contrast': '#ffffff',
		success: '#529e72',
		warning: '#ca8f3d'
	},
	...meta('plan', {
		note: 'Plan CSS block. Dark secondary (#252525, the gray block background) and dark info/secondary are additions.'
	})
} as const;

export const notion = {
	measuredAt: MEASURED_AT,
	measurement: {
		status: 'seeded-from-references' as const,
		liveDevToolsMeasurement: 'TODO: not yet done; no reference workspace login was available.',
		references: [
			'docs/PLAN.md (seed)',
			'https://cdn.jsdelivr.net/npm/@jungherz-de/notionkit@1.19.1/SKILL.md',
			'https://matthiasfrank.de/en/notion-colors/'
		]
	},
	core,
	highContrast,
	shadows,
	blockColors,
	optionColors,
	type,
	metrics,
	radii,
	motion,
	entasis
} as const;

export type NotionTokens = typeof notion;
