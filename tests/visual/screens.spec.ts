/**
 * Visual baselines of 20 key screens in both themes (40 snapshots, `__screenshots__/<screen>-<theme>.png`). See
 * playwright.config.ts for how to run and update them. The screens are listed in screens.ts; what changes between runs
 * is masked.
 */
import { openContext, snap, test, THEMES } from './fixtures';
import { reach, SCREENS } from './screens';

test.describe.configure({ mode: 'serial' });

for (const screen of SCREENS) {
	for (const theme of THEMES) {
		test(`${screen.name} (${theme})`, async ({ browser }) => {
			const { context, page } = await openContext(browser, { theme, as: screen.as ?? 'ada', viewport: screen.viewport, storage: screen.storage });
			try {
				await reach(page, screen, theme);
				await snap(page, screen.name, theme, { mask: screen.mask?.(page), clip: screen.clip });
			} finally {
				await context.close();
			}
		});
	}
}
