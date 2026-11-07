import type { AccessLevel } from '#lib/shared/protocol.ts';
import type { Teamspace } from '#lib/shared/schemas.ts';

/** The four page access levels, strongest first, as the share dialog and teamspace screens name them. */
export const LEVELS: readonly { value: AccessLevel; label: string }[] = [
	{ value: 'full', label: 'Full access' },
	{ value: 'update', label: 'Can edit' },
	{ value: 'comment', label: 'Can comment' },
	{ value: 'read', label: 'Can view' }
];

export const levelLabel = (level: AccessLevel): string => LEVELS.find((l) => l.value === level)?.label ?? level;

/** Strength of a level, for sorting and comparing (read 1 ... full 4). */
export const levelRank = (level: AccessLevel): number => ({ read: 1, comment: 2, update: 3, full: 4 })[level];

export const PRIVACY_OPTIONS: readonly { value: Teamspace['privacy']; label: string; hint: string }[] = [
	{ value: 'open', label: 'Open', hint: 'Anyone in the workspace can find the teamspace and join it.' },
	{ value: 'closed', label: 'Closed', hint: 'Anyone can find it, but people join by invitation.' },
	{ value: 'private', label: 'Private', hint: 'Only its members can see it.' }
];

export const privacyLabel = (privacy: Teamspace['privacy']): string => PRIVACY_OPTIONS.find((p) => p.value === privacy)?.label ?? privacy;
