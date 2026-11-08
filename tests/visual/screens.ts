/**
 * The 20 key screens of the app, and how a person reaches each one in the seeded workspace (seed.ts). The visual
 * baselines (screens.spec.ts) and the accessibility checks (a11y.spec.ts) walk the same list.
 */
import type { Page } from '@playwright/test';
import type { Seed } from './seed';
import { expect, ready, seeded, settle, type Theme } from './fixtures';

// Read when a test runs: the `seed` project writes the file before any of them.
export const seed = new Proxy({} as Seed, { get: (_target, key) => seeded()[key as keyof Seed] });
export const W = () => `/${seed.slug}`;

export interface Screen {
	name: string;
	as?: 'ada' | 'bob' | 'anonymous';
	/** Where the screen is. */
	path: (theme: Theme) => string;
	/** Gets the screen into the state it is photographed in. */
	prepare?: (page: Page) => Promise<void>;
	/** Locators of what changes between runs. */
	mask?: (page: Page) => import('@playwright/test').Locator[];
	/** Waits that the screen specific content is there. */
	until?: (page: Page) => Promise<void>;
	/** Photographed without the app shell around it (login, published page). */
	anonymous?: boolean;
	/** Pixels, not the viewport (the sidebar alone). */
	clip?: { x: number; y: number; width: number; height: number };
	/** Taller than the window. */
	viewport?: { width: number; height: number };
	/** `localStorage` entries set before the page loads. */
	storage?: Record<string, string>;
}

const blurEditor = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const viewReady = (page: Page) => expect(page.getByTestId('view-host')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
const openView = (view: string) => async (page: Page) => {
	await viewReady(page);
	await page.getByRole('tab', { name: view, exact: true }).click();
	await expect(page.getByTestId('view-host')).toHaveAttribute('data-view-type', /./);
	await viewReady(page);
	await expect(page.getByRole('tab', { name: view, exact: true })).toHaveAttribute('aria-selected', 'true');
};

export const SCREENS: Screen[] = [
	{ name: 'login', as: 'anonymous', anonymous: true, path: () => '/login', until: (page) => expect(page.getByRole('heading').first()).toBeVisible() },
	{ name: 'signup', as: 'anonymous', anonymous: true, path: () => '/signup', until: (page) => expect(page.getByRole('heading').first()).toBeVisible() },
	{
		name: 'home',
		path: () => W(),
		prepare: async (page) => {
			// Recent pages and favorites live in the browser: seed them the way the app does.
			await page.evaluate(
				({ recent, favorites }) => (window as unknown as { __flarion: { seedPrefs(r: string[], f: string[]): void } }).__flarion.seedPrefs(recent, favorites),
				{ recent: [seed.ids.launchPlan, seed.ids.tasks, seed.ids.roadmap, seed.ids.meetingNotes], favorites: [seed.ids.tasks, seed.ids.launchPlan] }
			);
			await expect(page.getByTestId('recent-card').first()).toBeVisible();
		}
	},
	{
		name: 'editor',
		path: () => `${W()}/${seed.ids.launchPlan}`,
		until: async (page) => {
			await expect(page.locator('[data-flarion-editor]')).toContainText('Brief support', { timeout: 30_000 });
		},
		// The editor takes focus when the page opens, which shows the handles of its empty block: look away.
		prepare: blurEditor
	},
	{
		name: 'properties',
		path: () => `${W()}/${seed.ids.taskRow}`,
		until: async (page) => {
			await expect(page.getByTestId('page-title')).toHaveValue('Ask AI panel');
			await expect(page.getByText('In progress').first()).toBeVisible();
		},
		prepare: blurEditor
	},
	{
		name: 'sidebar',
		path: () => `${W()}/${seed.ids.readingList}`,
		clip: { x: 0, y: 0, width: 260, height: 800 },
		prepare: async (page) => {
			await expect(page.getByTestId('tree-row').filter({ hasText: 'Meeting notes' })).toBeVisible();
			await expect(page.getByTestId('tree-row').filter({ hasText: 'Weekly sync' })).toBeVisible();
		}
	},
	{
		name: 'quick-find',
		path: () => W(),
		prepare: async (page) => {
			await page.getByTestId('sidebar-tree').click({ position: { x: 5, y: 5 } });
			await page.keyboard.press('ControlOrMeta+k');
			await page.getByRole('combobox').first().fill('road');
			await expect(page.getByTestId('quick-row').filter({ hasText: 'Product roadmap' }).first()).toBeVisible();
		}
	},
	{
		name: 'search',
		path: () => `${W()}/search?q=milestones`,
		mask: (page) => [page.getByTestId('search-results').locator('li').locator('span.text-xs').filter({ hasText: /Edited/ })],
		until: async (page) => {
			await expect(page.getByTestId('search-hit').first()).toContainText('Product roadmap');
		}
	},
	{
		name: 'ask-ai',
		path: () => W(),
		storage: { 'flarion:fake-ai': '1' },
		prepare: async (page) => {
			await page.keyboard.press('ControlOrMeta+j');
			const panel = page.getByTestId('ask-panel');
			await expect(panel).toBeVisible();
			await page.getByRole('textbox').last().fill('What are the milestones on the roadmap?');
			await page.keyboard.press('Enter');
			await expect(panel.getByTestId('ask-citation').first()).toBeVisible({ timeout: 30_000 });
			await expect(panel.getByText('According to your pages').first()).toBeVisible();
		}
	},
	{
		name: 'share',
		path: () => `${W()}/${seed.ids.launchPlan}`,
		prepare: async (page) => {
			await page.getByTestId('share-button').click();
			await expect(page.getByTestId('share-invite-input')).toBeVisible();
		},
		// The owner's email carries the run's id.
		mask: (page) => [page.getByTestId('share-grant-row').first().locator('span.text-xs, p.text-xs').first()]
	},
	{ name: 'table', path: () => `${W()}/${seed.ids.tasks}`, prepare: async (page) => { await viewReady(page); await expect(page.getByTestId('view-table')).toBeVisible(); } },
	{ name: 'board', path: () => `${W()}/${seed.ids.tasks}`, prepare: openView('By status') },
	{ name: 'calendar', path: () => `${W()}/${seed.ids.tasks}`, prepare: openView('Calendar') },
	{ name: 'timeline', path: () => `${W()}/${seed.ids.tasks}`, prepare: openView('Timeline') },
	{ name: 'gallery', path: () => `${W()}/${seed.ids.tasks}`, prepare: openView('Gallery') },
	{
		name: 'filter',
		path: () => `${W()}/${seed.ids.tasks}`,
		prepare: async (page) => {
			// The seeded List view carries a nested filter.
			await openView('List')(page);
			await page.getByTestId('view-filter').click();
			await expect(page.getByTestId('filter-builder')).toBeVisible();
			await expect(page.getByTestId('filter-builder').getByText('Priority').first()).toBeVisible();
		}
	},
	{
		name: 'trash',
		path: () => `${W()}/trash`,
		mask: (page) => [page.getByTestId('trash-table').getByRole('row').locator('[role="cell"]').filter({ hasText: /ago|just now|Just now|Today|Yesterday|202\d/i })],
		until: async (page) => {
			await expect(page.getByTestId('trash-row')).toHaveCount(2);
		}
	},
	{
		name: 'settings-members',
		path: () => `${W()}/settings/members`,
		// The emails carry the run's id.
		mask: (page) => [page.getByTestId('members-tab').getByText(/@example\.com/)],
		until: async (page) => { await expect(page.getByTestId('members-tab')).toBeVisible(); await expect(page.getByText(seed.bob.name).first()).toBeVisible(); } },
	{
		name: 'teamspace-settings',
		path: () => W(),
		prepare: async (page) => {
			const teamspace = page.getByTestId('teamspace').filter({ hasText: 'Design' });
			await teamspace.getByTestId('section-header').hover();
			await teamspace.getByRole('button', { name: /More actions for Design/ }).click();
			await page.getByRole('menuitem', { name: 'Teamspace settings' }).click();
			await expect(page.getByTestId('teamspace-settings-dialog')).toBeVisible();
		},
		mask: (page) => [page.getByTestId('teamspace-member-row').getByText(/@example\.com/)]
	},
	{
		name: 'published',
		as: 'anonymous',
		anonymous: true,
		path: () => `/share/${seed.shareToken}`,
		until: async (page) => {
			await expect(page.locator('body')).toContainText('Brief support');
		}
	}
];


/** Opens a screen and gets it into the state it is photographed in. A dev server that is reloading answers 500: reload. */
export async function reach(page: Page, screen: Screen, theme: Theme) {
	for (let attempt = 0; ; attempt++) {
		try {
			await page.goto(screen.path(theme));
			if (!screen.anonymous) await ready(page);
			await screen.until?.(page);
			await screen.prepare?.(page);
			await settle(page);
			return;
		} catch (error) {
			if (attempt >= 2) throw error;
		}
	}
}
