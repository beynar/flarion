/**
 * Preloaded into every Playwright worker (`NODE_OPTIONS=--import`, set by the suites' configs through `waitForHydration()`): after a navigation,
 * a page the server rendered is only live once its script has hydrated it, and a test that types into a field before then loses the text to
 * hydration (Svelte resets a bound input from state) or clicks a button that has no handler yet. The app marks itself with
 * `<html data-hydrated="true">` (root `+layout.svelte`); `goto`, `reload`, `goBack` and `goForward` of every page made through
 * `chromium.launch` wait for it on SvelteKit pages (the body carries `data-sveltekit-preload-data`) and ignore everything else
 * (published pages and the API reference have no script). `E2E_HYDRATE_WAIT=off` turns it off (the JavaScript-disabled specs).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const testPkg = require.resolve('@playwright/test/package.json');
const playwright = createRequire(testPkg)('playwright');
const core = createRequire(require.resolve('playwright/package.json', { paths: [testPkg] }))('playwright-core');

const wait = async (page) => {
	if (process.env.E2E_HYDRATE_WAIT === 'off') return;
	try {
		if (!(await page.evaluate(() => !!document.querySelector('body[data-sveltekit-preload-data]')))) return;
		await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true', null, { timeout: 30_000 });
	} catch {
		// closed, navigated away again, or no script (JavaScript disabled): the test's own assertions decide
	}
};

const patchPage = (page) => {
	if (page.__hydration) return page;
	page.__hydration = true;
	for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
		const original = page[name].bind(page);
		page[name] = async (...args) => {
			const result = await original(...args);
			await wait(page);
			return result;
		};
	}
	return page;
};

const patchContext = (context) => {
	if (context.__hydration) return context;
	context.__hydration = true;
	const newPage = context.newPage.bind(context);
	context.newPage = async (...args) => patchPage(await newPage(...args));
	context.on('page', patchPage);
	return context;
};

const patchBrowser = (browser) => {
	if (browser.__hydration) return browser;
	browser.__hydration = true;
	const newContext = browser.newContext.bind(browser);
	browser.newContext = async (...args) => patchContext(await newContext(...args));
	const newPage = browser.newPage.bind(browser);
	browser.newPage = async (...args) => patchPage(await newPage(...args));
	return browser;
};

for (const type of [core.chromium, playwright.chromium].filter(Boolean)) {
	if (type.__hydration) continue;
	type.__hydration = true;
	const launch = type.launch.bind(type);
	type.launch = async (...args) => patchBrowser(await launch(...args));
	const persistent = type.launchPersistentContext.bind(type);
	type.launchPersistentContext = async (...args) => patchContext(await persistent(...args));
}
