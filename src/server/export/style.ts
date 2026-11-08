/**
 * The stylesheet of a rendered page body (published pages and the standalone HTML export). The colours, fonts and
 * metrics are the app's design tokens (`src/lib/design/generated/page-vars.ts`: the values of `app-vars.css` and
 * `edytor-overrides.css`, generated from `notion.tokens.ts`) for a document without the app's `html[data-theme]`: the
 * light theme is the root, the dark one follows `prefers-color-scheme`. The rules mirror edytor's Notion theme (`edytor/themes/notion.css`:
 * 16px/1.5 text, 2px block gutters, 10px rounded panels, 24px nesting) for the semantic HTML `edytor/export` writes,
 * which carries none of the editor's own DOM.
 */
import { PAGE_VARS } from '../../lib/design/generated/page-vars';

const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

const content = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--app-page,#fff);color:var(--notion-text,var(--app-text));font-family:var(--notion-font);font-size:16px;line-height:1.5;-webkit-font-smoothing:auto}
.flarion-page{max-width:calc(var(--app-page-width,708px) + 2 * var(--app-page-padding-x-narrow,24px));margin:0 auto;padding:48px var(--app-page-padding-x-narrow,24px) 120px}
@media (min-width:768px){.flarion-page{max-width:calc(var(--app-page-width,708px) + 2 * var(--app-page-padding-x,96px));padding:80px var(--app-page-padding-x,96px) 160px}}
.flarion-page .page-icon{font-size:var(--app-page-icon-size,78px);line-height:1;margin-bottom:8px}
@media (max-width:767px){.flarion-page .page-icon{font-size:56px}}
.flarion-page .page-title{margin:0 0 24px;font-size:var(--app-font-size-title,40px);line-height:1.2;font-weight:700;overflow-wrap:anywhere}
@media (max-width:767px){.flarion-page .page-title{font-size:30px}}
.flarion-doc{word-break:break-word;overflow-wrap:anywhere}
.flarion-doc>*:first-child{margin-top:0}
.flarion-doc p{margin:1px 0;padding:3px 2px;min-height:1.5em}
.flarion-doc h1,.flarion-doc h2,.flarion-doc h3{margin:0;font-weight:600;padding:3px 2px}
.flarion-doc h1{font-size:1.875em;line-height:1.3;margin-top:2em;margin-bottom:4px}
.flarion-doc h2{font-size:1.5em;line-height:1.3;margin-top:1.4em;margin-bottom:1px}
.flarion-doc h3{font-size:1.25em;line-height:1.3;margin-top:1em;margin-bottom:1px}
.flarion-doc a{color:inherit;text-decoration:underline;text-decoration-color:var(--notion-text-secondary,var(--app-text-secondary));text-underline-offset:2px}
.flarion-doc a:hover{text-decoration-color:currentColor}
.flarion-doc ul,.flarion-doc ol{margin:1px 0;padding-left:1.7em}
.flarion-doc li{padding:3px 2px}
.flarion-doc li>p{padding:0}
.flarion-doc li:has(>input[type=checkbox]){list-style:none;margin-left:-1.4em}
.flarion-doc li>input[type=checkbox]{margin:0 .5em 0 0;vertical-align:-1px}
.flarion-doc blockquote{margin:1px 0;padding:0 14px;border-left:3px solid currentColor}
.flarion-doc blockquote>p{padding-left:0}
.flarion-doc hr{border:0;border-top:1px solid var(--notion-border,var(--app-hairline));margin:6px 0}
.flarion-doc strong{font-weight:600}
.flarion-doc code{font-family:var(--notion-mono);font-size:85%}
.flarion-doc :not(pre)>code{color:var(--notion-inline-code,#cf5148);background:var(--notion-code-panel,var(--app-code-panel));border-radius:4px;padding:.2em .4em}
.flarion-doc pre{margin:4px 0;padding:32px 16px;background:var(--notion-code-panel,var(--app-code-panel));border-radius:6px;overflow-x:auto;tab-size:2}
.flarion-doc pre code{background:none;color:inherit;padding:0;font-size:85%;line-height:1.5;white-space:pre}
.flarion-doc [data-edytor-callout]{display:flex;gap:8px;margin:4px 0;padding:16px 16px 16px 12px;background:var(--notion-panel,var(--app-callout));border:1px solid var(--notion-border,var(--app-hairline));border-radius:10px}
.flarion-doc [data-edytor-callout]::before{content:attr(data-edytor-callout);flex:none;min-width:1.5em;line-height:1.5}
.flarion-doc [data-edytor-callout]>p:first-child{flex:1;min-width:0;padding:0;margin:0}
.flarion-doc details{margin:1px 0;padding:0 2px}
.flarion-doc details>summary{cursor:pointer;padding:3px 0;list-style-position:outside}
.flarion-doc details>*:not(summary){margin-left:24px}
.flarion-doc table{border-collapse:collapse;margin:8px 0;max-width:100%;font-size:14px}
.flarion-doc td,.flarion-doc th{border:1px solid var(--notion-border,var(--app-hairline));padding:6px 10px;text-align:left;vertical-align:top;min-width:80px}
.flarion-doc th{background:var(--notion-panel,var(--app-callout));font-weight:500}
.flarion-doc thead th{white-space:nowrap}
@media (max-width:767px){.flarion-doc table{display:block;overflow-x:auto}}
.flarion-doc figure{margin:8px 0}
.flarion-doc figure>img,.flarion-doc figure>video{display:block;max-width:100%;height:auto;border-radius:4px}
.flarion-doc figure>audio{width:100%}
.flarion-doc figure[data-align=left]>img{margin-right:auto}
.flarion-doc figure[data-align=right]>img{margin-left:auto}
.flarion-doc figcaption{color:var(--notion-text-secondary,var(--app-text-secondary));font-size:14px;padding:4px 2px}
.flarion-doc figure[data-edytor-file],.flarion-doc figure[data-edytor-bookmark]{padding:8px 12px;border:1px solid var(--notion-border,var(--app-hairline));border-radius:6px}
.flarion-doc [data-edytor-database]>figcaption{font-size:14px;font-weight:600;color:inherit;padding:0 0 4px}
.flarion-doc [data-edytor-database]{overflow-x:auto}
.flarion-doc [data-edytor-columns]{display:flex;gap:16px;margin:4px 0}
.flarion-doc [data-edytor-column]{flex:1 1 0;min-width:0}
@media (max-width:767px){.flarion-doc [data-edytor-columns]{flex-direction:column;gap:0}}
.flarion-doc [data-edytor-toc]{color:var(--notion-text-secondary,var(--app-text-secondary));margin:4px 0}
.flarion-doc [data-edytor-toc] ul{list-style:none;margin:0;padding:0}
.flarion-doc [data-edytor-toc] li{padding:2px 2px;font-size:14px}
.flarion-doc [data-edytor-toc] li[data-edytor-toc-level="2"]{padding-left:16px}
.flarion-doc [data-edytor-toc] li[data-edytor-toc-level="3"]{padding-left:32px}
.flarion-doc p[data-edytor-page]{font-weight:500}
.flarion-doc p[data-edytor-page]::before{content:'\\1F4C4';margin-right:6px}
.flarion-doc [data-edytor-mention]{background:var(--notion-hover,var(--app-hover));border-radius:4px;padding:0 4px}
.flarion-doc [data-edytor-page-link]{border-bottom:1px solid var(--notion-border,var(--app-hairline));text-decoration:none;font-weight:500}
.flarion-doc [data-edytor-date]{color:var(--notion-text-secondary,var(--app-text-secondary));background:var(--notion-hover,var(--app-hover));border-radius:4px;padding:0 4px}
.flarion-doc [data-edytor-equation]{margin:6px 0;text-align:center;overflow-x:auto}
.flarion-doc .katex{font-family:var(--notion-mono);font-style:italic}
.flarion-doc mark{background:transparent}
.flarion-doc sup,.flarion-doc sub{line-height:0}
${COLORS.map((c) => `.flarion-doc .block-color-${c}{color:var(--edytor-color-${c})}.flarion-doc .block-color-${c}_background{background:var(--edytor-background-${c})}`).join('\n')}
`;

let cached: string | undefined;

/** The page stylesheet: token variables (light, then dark under `prefers-color-scheme`), then the rules. */
export function exportStyles(): string {
	if (cached) return cached;
	cached =
		`:root{color-scheme:light dark;${PAGE_VARS.light}}` +
		`@media (prefers-color-scheme:dark){:root{${PAGE_VARS.dark}}}` +
		content.replace(/\n+/g, '\n').trim();
	return cached;
}
