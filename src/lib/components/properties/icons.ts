import type { PropertyType } from '#lib/shared/property-types.ts';
import { textTIcon } from 'entasis/icons/textT';
import { hashIcon } from 'entasis/icons/hash';
import { tagIcon } from 'entasis/icons/tag';
import { listBulletsIcon } from 'entasis/icons/listBullets';
import { circleDashedIcon } from 'entasis/icons/circleDashed';
import { calendarBlankIcon } from 'entasis/icons/calendarBlank';
import { userCircleIcon } from 'entasis/icons/userCircle';
import { paperclipIcon } from 'entasis/icons/paperclip';
import { checkSquareIcon } from 'entasis/icons/checkSquare';
import { linkIcon } from 'entasis/icons/link';
import { envelopeIcon } from 'entasis/icons/envelope';
import { phoneIcon } from 'entasis/icons/phone';
import { arrowUpRightIcon } from 'entasis/icons/arrowUpRight';
import { clockIcon } from 'entasis/icons/clock';
import { functionIcon } from 'entasis/icons/function';
import { sigmaIcon } from 'entasis/icons/sigma';
import { sparkleIcon } from 'entasis/icons/sparkle';
import { fingerprintIcon } from 'entasis/icons/fingerprint';

/** The icon snippet of each property type (render with `{@render icon({ size: 16 })}`). */
export const TYPE_ICONS: Record<PropertyType, typeof textTIcon> = {
	title: textTIcon,
	text: textTIcon,
	number: hashIcon,
	select: tagIcon,
	multi_select: listBulletsIcon,
	status: circleDashedIcon,
	date: calendarBlankIcon,
	person: userCircleIcon,
	files: paperclipIcon,
	checkbox: checkSquareIcon,
	url: linkIcon,
	email: envelopeIcon,
	phone: phoneIcon,
	relation: arrowUpRightIcon,
	created_time: clockIcon,
	last_edited_time: clockIcon,
	created_by: userCircleIcon,
	last_edited_by: userCircleIcon,
	formula: functionIcon,
	rollup: sigmaIcon,
	ai: sparkleIcon,
	unique_id: fingerprintIcon
};
