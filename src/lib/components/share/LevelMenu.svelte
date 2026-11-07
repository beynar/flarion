<script lang="ts">
	import { Button } from 'entasis/button';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { caretDownIcon } from 'entasis/icons/caretDown';
	import type { AccessLevel } from '#lib/shared/protocol.ts';
	import { LEVELS, levelLabel } from '#lib/components/teamspaces/levels.ts';

	/**
	 * Notion's access control: a ghost "Can edit" button that opens a menu with the four levels as a radio group
	 * and, for a row that can be taken away, a danger "Remove" entry under a separator. Forms that only pick a
	 * value (teamspace default access) use `Select` instead.
	 */
	let {
		value,
		label,
		onchange,
		onremove,
		disabled = false,
		variant = 'ghost',
		testid = 'share-level'
	}: {
		value: AccessLevel;
		/** The accessible name, e.g. `Access level of Grace Hopper`. */
		label: string;
		onchange: (level: AccessLevel) => void;
		/** Adds a danger "Remove" entry (a grant row); left out for the invite box. */
		onremove?: () => void;
		disabled?: boolean;
		variant?: 'ghost' | 'outline';
		testid?: string;
	} = $props();

	const items = $derived<MenuItem[]>([
		{
			type: 'radio-group',
			label: 'Access level',
			value,
			closeOnClick: true,
			onValueChange: (next) => onchange(next as AccessLevel),
			items: LEVELS.map((l) => ({ value: l.value, title: l.label }))
		},
		...(onremove
			? ([
					{ type: 'separator' },
					{ type: 'option', title: 'Remove', color: 'danger', onclick: onremove, attrs: { 'data-testid': 'share-remove' } }
				] satisfies MenuItem[])
			: [])
	]);
</script>

<PopupMenu position="bottom-end" menu={{ items }}>
	{#snippet trigger(popover)}
		<Button {variant} size="small" {disabled} {label} suffix={caretDownIcon} data-testid={testid} {@attach popover.trigger}>{levelLabel(value)}</Button>
	{/snippet}
</PopupMenu>
