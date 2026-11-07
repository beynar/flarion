import type { SidebarGroup, SidebarTreeNode } from 'entasis/sidebar';
import { plusIcon } from 'entasis/icons/plus';
import {
	buildTree,
	pages,
	teamspaces,
	type MockPage,
	type MockTreeNode
} from '#lib/client/mock.ts';

function toNode(node: MockTreeNode, ws: string, active: string | undefined): SidebarTreeNode {
	return {
		label: node.page.title,
		icon: node.page.icon,
		href: `/${ws}/${node.page.slug}`,
		isActive: node.page.slug === active,
		defaultOpen: node.children.some((child) => containsSlug(child, active)) || undefined,
		children: node.children.length ? node.children.map((child) => toNode(child, ws, active)) : undefined
	};
}

function containsSlug(node: MockTreeNode, slug: string | undefined): boolean {
	return node.page.slug === slug || node.children.some((child) => containsSlug(child, slug));
}

function tree(list: MockPage[], ws: string, active: string | undefined): SidebarTreeNode[] {
	return buildTree(list).map((node) => toNode(node, ws, active));
}

/** Teamspaces, Shared and Private sections for the sidebar, built from the mock pages. */
export function sidebarGroups(
	ws: string,
	active: string | undefined,
	onNewPage: () => void
): SidebarGroup[] {
	const add = (label: string) => ({ icon: plusIcon, label, onclick: onNewPage });
	return [
		{
			label: 'Teamspaces',
			collapsible: true,
			defaultOpen: true,
			action: add('Add a teamspace page'),
			tree: teamspaces.map((name) => ({
				label: name,
				icon: name === 'Engineering' ? '⚙️' : '🎨',
				defaultOpen: true,
				children: tree(
					pages.filter((page) => page.section === 'teamspace' && page.teamspace === name),
					ws,
					active
				)
			}))
		},
		{
			label: 'Shared',
			collapsible: true,
			defaultOpen: true,
			tree: tree(
				pages.filter((page) => page.section === 'shared'),
				ws,
				active
			)
		},
		{
			label: 'Private',
			collapsible: true,
			defaultOpen: true,
			action: add('Add a private page'),
			tree: tree(
				pages.filter((page) => page.section === 'private'),
				ws,
				active
			)
		}
	];
}
