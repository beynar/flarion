/**
 * Accessibility: axe (`@axe-core/playwright`, WCAG 2.0 to 2.2 A and AA) on the 20 key screens, in both themes.
 *
 * Contrast is a deliberate exception by default: Notion's secondary and tertiary text sit a little below AA, and the app
 * keeps them (docs/PLAN.md "Design system"). So the standard setting runs every rule except `color-contrast`, and the
 * high-contrast setting (`localStorage['flarion.contrast'] = 'high'`, the one in Settings > Appearance) runs all of them,
 * contrast included: that is where the app promises 4.5:1 everywhere.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, openContext, test, THEMES, type Theme } from './fixtures';
import { reach, SCREENS, type Screen } from './screens';


const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: import('@playwright/test').Page, withContrast: boolean) {
	// Some names are set a moment after the content (an editor's to-do labels): let them land.
	await page.waitForTimeout(800);
	const builder = new AxeBuilder({ page }).withTags(TAGS);
	if (!withContrast) builder.disableRules(['color-contrast']);
	const { violations } = await builder.analyze();
	return violations.map((violation) => ({
		rule: violation.id,
		impact: violation.impact,
		help: violation.help,
		nodes: violation.nodes.slice(0, 4).map((node) => `${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`)
	}));
}

for (const contrast of ['standard', 'high'] as const) {
	for (const screen of SCREENS) {
		for (const theme of THEMES) {
			test(`${screen.name} (${theme}, ${contrast} contrast)`, async ({ browser }) => {
				const storage = { ...screen.storage, ...(contrast === 'high' ? { 'flarion.contrast': 'high' } : {}) };
				const { context, page } = await openContext(browser, { theme, as: screen.as ?? 'ada', viewport: screen.viewport, storage });
				try {
					await reach(page, screen as Screen, theme as Theme);
					expect(await audit(page, contrast === 'high')).toEqual([]);
				} finally {
					await context.close();
				}
			});
		}
	}
}
