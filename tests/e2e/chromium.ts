/**
 * Which Chromium the e2e suites launch. Playwright normally finds its own pinned build in
 * `~/Library/Caches/ms-playwright`; when that exact revision is not installed (the cache holds an older
 * one) the suites fall back to the newest cached headless shell or Chromium, so no setup is needed.
 * `E2E_CHROMIUM=/path/to/chrome-or-headless-shell` always wins.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Revision Playwright wants (browsers.json of the installed playwright-core), or null. */
function pinnedRevision(): string | null {
	try {
		const core = require.resolve('playwright-core/package.json', { paths: [require.resolve('@playwright/test')] });
		const { browsers } = require(join(core, '..', 'browsers.json')) as { browsers: { name: string; revision: string }[] };
		return browsers.find((browser) => browser.name === 'chromium-headless-shell')?.revision ?? null;
	} catch {
		return null;
	}
}

function cacheDir(): string {
	if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
	if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright');
	return join(homedir(), '.cache', 'ms-playwright');
}

/** `launchOptions` for the project: an explicit or auto-detected executable, or `{}` to let Playwright decide. */
export function chromiumLaunchOptions(): { executablePath?: string } {
	if (process.env.E2E_CHROMIUM) return { executablePath: process.env.E2E_CHROMIUM };
	const dir = cacheDir();
	if (!existsSync(dir)) return {};
	const entries = readdirSync(dir);
	const wanted = pinnedRevision();
	// The pinned revision is installed: Playwright finds it by itself.
	if (wanted && entries.includes(`chromium_headless_shell-${wanted}`)) return {};
	const revision = (name: string) => Number(name.split('-').pop());
	const newest = (prefix: string) =>
		entries
			.filter((entry) => entry.startsWith(`${prefix}-`))
			.sort((a, b) => revision(b) - revision(a));
	for (const shell of newest('chromium_headless_shell')) {
		const base = join(dir, shell);
		for (const arch of readdirSync(base)) {
			const executable = join(base, arch, 'chrome-headless-shell');
			if (existsSync(executable)) return { executablePath: executable };
		}
	}
	for (const chromium of newest('chromium')) {
		const base = join(dir, chromium);
		for (const arch of readdirSync(base)) {
			const executable = join(base, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
			if (existsSync(executable)) return { executablePath: executable };
		}
	}
	return {};
}
