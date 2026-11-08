/**
 * The workspace every visual, accessibility and metrics test looks at, built once per run through the real app: two
 * people sign up with virtual passkeys, a workspace is created, and its data is written through the RPCs (the same calls
 * the client makes). The data is fixed (names, titles, dates in November 2026, a database with six views), so the
 * screens of two runs match; what differs between runs (ids, emails, times) is masked or never shown.
 *
 * `seed()` (run by seed.setup.ts) writes `tests/visual/.state/{seed.json,ada.json,bob.json}` (the ids, and each person's signed-in browser state),
 * which every test reads instead of seeding again. The folder is git-ignored.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	acceptInvite,
	expectLive,
	inviteMember,
	newPerson,
	rpcCall,
	signUpAndCreateWorkspace,
	waitForBodyIndexed,
	workspaceIdOf,
	writeBody,
	type Person
} from '../e2e/app/helpers';

export const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.state');
export const SEED_FILE = `${STATE_DIR}/seed.json`;
export const ADA_STATE = `${STATE_DIR}/ada.json`;
export const BOB_STATE = `${STATE_DIR}/bob.json`;

/** The time every visual test pins the page's clock to (November 2026: the calendar and the greeting depend on it). */
export const FIXED_NOW = '2026-11-15T10:00:00.000Z';

export interface Seed {
	slug: string;
	workspaceId: string;
	ada: { email: string; name: string; userId: string };
	bob: { email: string; name: string; userId: string };
	/** Page ids by role. */
	ids: {
		launchPlan: string;
		roadmap: string;
		meetingNotes: string;
		/** A private page tests may type into without touching the pages the screens show. */
		scratch: string;
		readingList: string;
		tasks: string;
		taskRow: string;
		designTeamspace: string;
		generalTeamspace: string;
	};
	/** View ids of the database. */
	views: { table: string; board: string; calendar: string; timeline: string; gallery: string; list: string };
	/** Token of the published page (`/share/<token>`). */
	shareToken: string;
}

const OPTIONS = {
	status: [
		{ id: 'not_started', name: 'Not started', color: 'gray' },
		{ id: 'in_progress', name: 'In progress', color: 'blue' },
		{ id: 'in_review', name: 'In review', color: 'yellow' },
		{ id: 'done', name: 'Done', color: 'green' }
	],
	priority: [
		{ id: 'low', name: 'Low', color: 'gray' },
		{ id: 'medium', name: 'Medium', color: 'orange' },
		{ id: 'high', name: 'High', color: 'red' }
	],
	tags: [
		{ id: 'search', name: 'Search', color: 'purple' },
		{ id: 'ai', name: 'AI', color: 'pink' },
		{ id: 'design', name: 'Design', color: 'blue' },
		{ id: 'infra', name: 'Infra', color: 'brown' }
	]
};

const TASKS: { title: string; status: string; priority: string; due: string | { start: string; end: string }; estimate: number; tags: string[]; who: 'ada' | 'bob' }[] = [
	{ title: 'Ship quick find', status: 'done', priority: 'high', due: '2026-11-03', estimate: 5, tags: ['search'], who: 'ada' },
	{ title: 'Search page filters', status: 'in_review', priority: 'medium', due: { start: '2026-11-09', end: '2026-11-13' }, estimate: 8, tags: ['search'], who: 'bob' },
	{ title: 'Ask AI panel', status: 'in_progress', priority: 'high', due: { start: '2026-11-12', end: '2026-11-19' }, estimate: 13, tags: ['ai'], who: 'ada' },
	{ title: 'Accessibility audit', status: 'in_progress', priority: 'high', due: '2026-11-16', estimate: 8, tags: ['design'], who: 'bob' },
	{ title: 'Mobile web layout', status: 'not_started', priority: 'medium', due: { start: '2026-11-17', end: '2026-11-24' }, estimate: 8, tags: ['design'], who: 'ada' },
	{ title: 'Visual regression suite', status: 'not_started', priority: 'medium', due: '2026-11-20', estimate: 5, tags: ['design', 'infra'], who: 'bob' },
	{ title: 'High contrast setting', status: 'in_review', priority: 'low', due: '2026-11-18', estimate: 3, tags: ['design'], who: 'ada' },
	{ title: 'Public API reference', status: 'in_progress', priority: 'medium', due: { start: '2026-11-10', end: '2026-11-26' }, estimate: 13, tags: ['infra'], who: 'bob' },
	{ title: 'Load test', status: 'not_started', priority: 'low', due: '2026-11-23', estimate: 5, tags: ['infra'], who: 'ada' },
	{ title: 'Backup restore drill', status: 'not_started', priority: 'high', due: '2026-11-27', estimate: 3, tags: ['infra'], who: 'bob' },
	{ title: 'CSV import', status: 'done', priority: 'medium', due: '2026-11-05', estimate: 8, tags: [], who: 'ada' },
	{ title: 'AI properties', status: 'in_review', priority: 'medium', due: '2026-11-13', estimate: 5, tags: ['ai'], who: 'bob' }
];

const COLUMN_PROPS = ['status', 'priority', 'assignee', 'due', 'estimate', 'tags'];

/** The body of the "Launch plan" page, typed with Markdown shortcuts into the real editor. */
const LAUNCH_PLAN = [
	'## Goals',
	'- Ship quick find and the Ask AI panel',
	'- Make the app work on phones',
	'- Cover every screen with visual tests',
	'',
	'## Timeline',
	'The launch is planned for the end of November. Search and the Ask AI panel land first; accessibility and the visual suite follow.',
	'## Checklist',
	'[] Write the announcement',
	'Brief support'
];

/** Types lines into the open editor: Markdown shortcuts turn `## ` and `- ` into blocks; an empty line leaves a list. */
async function typeLines(page: Page, lines: string[]) {
	for (const [index, line] of lines.entries()) {
		if (line) await page.keyboard.type(line);
		if (index < lines.length - 1) await page.keyboard.press('Enter');
	}
}

export async function seed(browser: Browser): Promise<Seed> {
	mkdirSync(STATE_DIR, { recursive: true });
	const id = Date.now().toString(36);
	const ada = await newPerson(browser, 'Ada Stone', `ada-visual-${id}@example.com`);
	const bob = await newPerson(browser, 'Ben Carter', `ben-visual-${id}@example.com`);
	const slug = await signUpAndCreateWorkspace(ada, 'Acme Studio');
	const workspaceId = await workspaceIdOf(ada.page, slug);
	await acceptInvite(bob, await inviteMember(ada, slug, bob), slug);

	const call = <T = unknown>(path: string, input: unknown = {}) => rpcCall<T>(ada.page, workspaceId, path, input);
	const members = await call<{ userId: string; email: string }[]>('workspace/members/list');
	const userId = (person: Person) => members.find((m) => m.email === person.email)!.userId;
	const adaId = userId(ada);
	const bobId = userId(bob);

	const teamspaces = await call<{ id: string; name: string }[]>('workspace/teamspaces/list');
	const generalTeamspace = teamspaces.find((t) => t.name === 'General')!.id;
	const design = await call<{ id: string }>('workspace/teamspaces/create', { name: 'Design', icon: '🎨', description: 'Brand, product design and research.', privacy: 'open', defaultLevel: 'update' });

	const make = async (title: string, extra: Record<string, unknown> = {}) =>
		(await call<{ id: string }>('page/create', { parentId: null, teamspaceId: generalTeamspace, values: { title }, ...extra })).id;

	// General: the launch plan (with a body) and the database.
	const launchPlan = await make('Launch plan', { icon: '🚀' });
	const roadmap = await make('Product roadmap', { icon: '🗺️' });
	// Private pages of Ada: a page with a sub-page.
	const meetingNotes = await make('Meeting notes', { teamspaceId: null, icon: '📝' });
	const readingList = await make('Reading list', { teamspaceId: null, parentId: meetingNotes, icon: '📚' });
	await make('Weekly sync', { teamspaceId: null, parentId: meetingNotes, icon: '🔁' });
	const scratch = await make('Scratch pad', { teamspaceId: null, icon: '✏️' });
	// A page in the Design teamspace.
	await make('Brand guidelines', { teamspaceId: design.id, icon: '🎨' });
	// Pages in the trash.
	for (const title of ['Old draft', 'Scratch notes']) {
		const trashed = await make(title, { teamspaceId: null });
		await call('page/trash', { id: trashed });
	}

	// The database.
	for (const property of [
		{ id: 'status', name: 'Status', type: 'status', config: { options: OPTIONS.status, groups: [{ id: 'todo', name: 'To-do', color: 'gray', optionIds: ['not_started'] }, { id: 'doing', name: 'In progress', color: 'blue', optionIds: ['in_progress', 'in_review'] }, { id: 'complete', name: 'Complete', color: 'green', optionIds: ['done'] }] } },
		{ id: 'priority', name: 'Priority', type: 'select', config: { options: OPTIONS.priority } },
		{ id: 'assignee', name: 'Assignee', type: 'person', config: {} },
		{ id: 'due', name: 'Due', type: 'date', config: {} },
		{ id: 'estimate', name: 'Estimate', type: 'number', config: { format: 'number' } },
		{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: OPTIONS.tags } }
	]) {
		await call('property/create', { property });
	}
	const tasks = (await call<{ id: string }>('page/create', { parentId: null, teamspaceId: generalTeamspace, isDatabase: true, icon: '🗂️', values: { title: 'Project tasks' } })).id;
	await call('collection/create', { id: tasks, pageId: tasks, sourceAst: { and: [{ prop: '$parent', op: 'is', value: tasks }] } });
	const columns = { columns: COLUMN_PROPS.map((prop) => ({ prop })), options: {} };
	const view = async (type: string, name: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
		(await call<{ id: string }>('view/create', { collectionId: tasks, type, name, columns: { ...columns, options }, ...extra })).id;
	const views = {
		table: await view('table', 'All tasks'),
		board: await view('board', 'By status', { groupBy: { prop: 'status' } }),
		calendar: await view('calendar', 'Calendar', {}, { dateProp: 'due' }),
		timeline: await view('timeline', 'Timeline', {}, { dateProp: 'due' }),
		gallery: await view('gallery', 'Gallery', {}, { cardSize: 'medium' }),
		// The view the filter builder is photographed on: a nested filter and a sort.
		list: await view('list', 'List', {
			filter: { and: [{ prop: 'status', op: 'is_not', value: 'done' }, { or: [{ prop: 'priority', op: 'is', value: 'high' }, { prop: 'estimate', op: 'gte', value: 8 }] }] },
			sorts: [{ prop: 'due', dir: 'asc' }]
		})
	};
	let taskRow = '';
	for (const task of TASKS) {
		const made = await call<{ id: string }>('page/create', {
			parentId: tasks,
			values: {
				title: task.title,
				status: task.status,
				priority: task.priority,
				assignee: [task.who === 'ada' ? adaId : bobId],
				due: typeof task.due === 'string' ? { start: task.due } : task.due,
				estimate: task.estimate,
				tags: task.tags
			}
		});
		if (task.title === 'Ask AI panel') taskRow = made.id;
	}

	// The launch plan's body, typed in the real editor; the same page is published.
	await ada.page.goto(`/${slug}/${launchPlan}`);
	await ada.page.waitForSelector('[data-flarion-editor] [data-edytor][contenteditable]');
	await ada.page.locator('[data-flarion-editor] [data-edytor]').click();
	await typeLines(ada.page, LAUNCH_PLAN);
	await expect.poll(() => ada.page.locator('[data-flarion-editor]').innerText()).toContain('Brief support');
	const grant = await call<{ token?: string }>('page/grants/set', { pageId: launchPlan, subjectKind: 'public', subjectId: null, level: 'read' });
	expect(grant.token, 'the public grant carries the share token').toBeTruthy();

	// Another body, found by search and quoted by Ask AI (it reaches the index in about 30 seconds).
	await writeBody(ada.page, slug, roadmap, 'The roadmap has three milestones: quick find, the Ask AI panel, and the visual regression suite.');
	await waitForBodyIndexed(ada.page, workspaceId, 'milestones', roadmap);

	await ada.page.goto(`/${slug}`);
	await expectLive(ada.page);
	await ada.context.storageState({ path: ADA_STATE });
	await bob.context.storageState({ path: BOB_STATE });

	const state: Seed = {
		slug,
		workspaceId,
		ada: { email: ada.email, name: ada.name, userId: adaId },
		bob: { email: bob.email, name: bob.name, userId: bobId },
		ids: { launchPlan, roadmap, meetingNotes, scratch, readingList, tasks, taskRow, designTeamspace: design.id, generalTeamspace },
		views,
		shareToken: grant.token!
	};
	writeFileSync(SEED_FILE, JSON.stringify(state, null, 2));
	await ada.context.close();
	await bob.context.close();
	return state;
}
