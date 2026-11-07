/**
 * Static mock data for the P0 app shell. There is no backend yet: every screen reads from here.
 * The shapes are local and deliberately plain; the real ones come from `lib/shared` and the
 * workspace runes store once those land.
 */

export type MockSection = 'teamspace' | 'shared' | 'private';

export type MockPage = {
	/** URL segment: `/{ws}/{slug}`. */
	slug: string;
	title: string;
	/** An emoji, as Notion pages carry. */
	icon: string;
	section: MockSection;
	/** Teamspace name for pages in the `teamspace` section. */
	teamspace?: string;
	parent?: string;
	favorite?: boolean;
	/** A cover gradient name from `covers`, if the page has one. */
	cover?: keyof typeof covers;
	visitedAt: string;
	editedBy: string;
	properties: Array<{ name: string; type: 'person' | 'status' | 'date' | 'select' | 'text'; value: string; color?: string }>;
};

export const user = {
	id: 'u_ada',
	name: 'Ada Lovelace',
	email: 'ada@acme.example',
	initials: 'AL'
};

export const workspace = {
	slug: 'acme',
	name: 'Acme',
	plan: 'Free plan',
	members: 4
};

export const covers = {
	dawn: 'linear-gradient(120deg, #f6d5c4 0%, #f2b7a0 45%, #d98e9a 100%)',
	lake: 'linear-gradient(120deg, #b7d4e6 0%, #8fb6d0 50%, #6a97b5 100%)',
	moss: 'linear-gradient(120deg, #cfe0c9 0%, #a8c7a0 50%, #7fa882 100%)',
	dusk: 'linear-gradient(120deg, #cbbfe0 0%, #a89ac9 50%, #8374b0 100%)'
} as const;

export const teamspaces = ['Engineering', 'Design'] as const;

export const pages: MockPage[] = [
	{
		slug: 'getting-started',
		title: 'Getting started',
		icon: '👋',
		section: 'private',
		favorite: true,
		cover: 'lake',
		visitedAt: '2 minutes ago',
		editedBy: 'Ada Lovelace',
		properties: [
			{ name: 'Owner', type: 'person', value: 'Ada Lovelace' },
			{ name: 'Status', type: 'status', value: 'In progress', color: 'blue' },
			{ name: 'Due', type: 'date', value: 'November 21, 2026' },
			{ name: 'Tags', type: 'select', value: 'Onboarding', color: 'green' }
		]
	},
	{
		slug: 'meeting-notes',
		title: 'Meeting notes',
		icon: '🗒️',
		section: 'private',
		parent: 'getting-started',
		visitedAt: 'Yesterday',
		editedBy: 'Ada Lovelace',
		properties: []
	},
	{
		slug: 'reading-list',
		title: 'Reading list',
		icon: '📚',
		section: 'private',
		favorite: true,
		cover: 'dusk',
		visitedAt: '3 days ago',
		editedBy: 'Ada Lovelace',
		properties: [{ name: 'Status', type: 'status', value: 'Not started', color: 'gray' }]
	},
	{
		slug: 'architecture',
		title: 'Architecture overview',
		icon: '🧭',
		section: 'teamspace',
		teamspace: 'Engineering',
		visitedAt: '1 hour ago',
		editedBy: 'Grace Hopper',
		cover: 'moss',
		properties: [
			{ name: 'Owner', type: 'person', value: 'Grace Hopper' },
			{ name: 'Status', type: 'status', value: 'Done', color: 'green' }
		]
	},
	{
		slug: 'sync-engine',
		title: 'Sync engine',
		icon: '🔁',
		section: 'teamspace',
		teamspace: 'Engineering',
		parent: 'architecture',
		visitedAt: '4 hours ago',
		editedBy: 'Grace Hopper',
		properties: []
	},
	{
		slug: 'roadmap',
		title: 'Roadmap',
		icon: '🗺️',
		section: 'teamspace',
		teamspace: 'Engineering',
		favorite: true,
		visitedAt: 'Yesterday',
		editedBy: 'Alan Turing',
		properties: [{ name: 'Status', type: 'status', value: 'In progress', color: 'blue' }]
	},
	{
		slug: 'brand-guidelines',
		title: 'Brand guidelines',
		icon: '🎨',
		section: 'teamspace',
		teamspace: 'Design',
		cover: 'dawn',
		visitedAt: 'Last week',
		editedBy: 'Margaret Hamilton',
		properties: []
	},
	{
		slug: 'launch-plan',
		title: 'Launch plan',
		icon: '🚀',
		section: 'shared',
		visitedAt: '2 days ago',
		editedBy: 'Grace Hopper',
		properties: [
			{ name: 'Owner', type: 'person', value: 'Grace Hopper' },
			{ name: 'Status', type: 'status', value: 'In progress', color: 'orange' }
		]
	}
];

export function getPage(slug: string): MockPage | undefined {
	return pages.find((page) => page.slug === slug);
}

/** Ancestors first, the page itself last. */
export function pagePath(slug: string): MockPage[] {
	const path: MockPage[] = [];
	let current = getPage(slug);
	while (current) {
		path.unshift(current);
		current = current.parent ? getPage(current.parent) : undefined;
	}
	return path;
}

export type MockTreeNode = { page: MockPage; children: MockTreeNode[] };

export function buildTree(list: MockPage[]): MockTreeNode[] {
	const nodes = new Map(list.map((page) => [page.slug, { page, children: [] as MockTreeNode[] }]));
	const roots: MockTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.page.parent ? nodes.get(node.page.parent) : undefined;
		(parent ? parent.children : roots).push(node);
	}
	return roots;
}

export const recentPages = [...pages].sort((a, b) => order(a.visitedAt) - order(b.visitedAt)).slice(0, 5);
export const favoritePages = pages.filter((page) => page.favorite);

function order(visitedAt: string): number {
	const ranks = ['2 minutes ago', '1 hour ago', '4 hours ago', 'Yesterday', '2 days ago', '3 days ago', 'Last week'];
	const rank = ranks.indexOf(visitedAt);
	return rank === -1 ? ranks.length : rank;
}

export const trashedPages = [
	{ slug: 'old-draft', title: 'Old draft', icon: '📝', deletedAt: '2 days ago', deletedBy: 'Ada Lovelace' },
	{ slug: 'scratch', title: 'Scratch pad', icon: '✏️', deletedAt: '5 days ago', deletedBy: 'Alan Turing' }
];

export const members = [
	{ name: 'Ada Lovelace', email: 'ada@acme.example', role: 'Owner' },
	{ name: 'Grace Hopper', email: 'grace@acme.example', role: 'Admin' },
	{ name: 'Alan Turing', email: 'alan@acme.example', role: 'Member' },
	{ name: 'Margaret Hamilton', email: 'margaret@acme.example', role: 'Member' }
];

export const invite = {
	workspace: 'Acme',
	invitedBy: 'Grace Hopper',
	email: 'new.teammate@example.com'
};

export const sharedPage = {
	title: 'Launch plan',
	icon: '🚀',
	publishedAt: 'November 6, 2026',
	blocks: [
		{ kind: 'heading', text: 'Why we launch in December' },
		{
			kind: 'paragraph',
			text: 'The sync engine, permissions and the first database views are ready. This page walks through what ships and in which order.'
		},
		{ kind: 'bullet', text: 'Week 1: private beta with five teams' },
		{ kind: 'bullet', text: 'Week 2: public sharing and the import tool' },
		{ kind: 'bullet', text: 'Week 3: general availability' }
	]
};

export const commandItems = [
	{
		heading: 'Recent',
		items: recentPages.slice(0, 4).map((page) => ({
			value: `page:${page.slug}`,
			label: page.title,
			emoji: page.icon,
			href: `/${workspace.slug}/${page.slug}`
		}))
	},
	{
		heading: 'Actions',
		items: [
			{ value: 'action:new-page', label: 'New page', shortcut: '⌘N' },
			{ value: 'action:toggle-sidebar', label: 'Toggle sidebar', shortcut: '⌘\\' },
			{ value: 'action:toggle-dark', label: 'Toggle dark mode', shortcut: '⌘⇧L' },
			{ value: 'action:trash', label: 'Open trash', href: `/${workspace.slug}/trash` },
			{ value: 'action:settings', label: 'Open settings', href: `/${workspace.slug}/settings` }
		]
	}
];
