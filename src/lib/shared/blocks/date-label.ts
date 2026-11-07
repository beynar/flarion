/**
 * How a date mention reads in a sentence (docs/PLAN.md "Pages and blocks": a custom inline block with a date,
 * an optional time and end, and a relative display): "Today", "Tomorrow", "Yesterday", "Friday", "Next Friday",
 * "Last Monday", else "Nov 7" (with the year when it is not this one). A timed value adds the time, a range
 * joins both ends with an arrow. Pure and deterministic given `now`, so it is unit-tested.
 *
 * A date-only value ("2026-11-07") has no time zone: it is the reader's calendar day. A timed value is an
 * instant (`...Z`) shown in the reader's zone.
 */
import { parseIsoDate, type DateValue } from '../dates.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

interface Parts {
	/** The calendar day as a UTC-midnight number (days are compared by subtracting these). */
	day: number;
	year: number;
	month: number;
	date: number;
	weekday: number;
	/** Local time, or null for a date-only value. */
	time: { hours: number; minutes: number } | null;
}

/** The calendar day and time of an ISO value in the reader's zone (date-only values keep their own day). */
export function partsOf(iso: string): Parts | null {
	const parsed = parseIsoDate(iso);
	if (!parsed) return null;
	if (parsed.dateOnly) {
		const d = new Date(parsed.ms);
		return { day: parsed.ms, year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), weekday: d.getUTCDay(), time: null };
	}
	const d = new Date(parsed.ms);
	return {
		day: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()),
		year: d.getFullYear(),
		month: d.getMonth(),
		date: d.getDate(),
		weekday: d.getDay(),
		time: { hours: d.getHours(), minutes: d.getMinutes() }
	};
}

const todayOf = (now: Date) => Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

/** Monday-based index of the week a UTC-midnight day number falls in. */
const weekIndex = (day: number) => Math.floor((day / DAY_MS + 3) / 7);

export function formatTime({ hours, minutes }: { hours: number; minutes: number }): string {
	const h12 = hours % 12 === 0 ? 12 : hours % 12;
	return `${h12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** The day label of one end of a mention, relative to `now`. */
export function relativeDayLabel(parts: Parts, now: Date): string {
	const today = todayOf(now);
	const diff = Math.round((parts.day - today) / DAY_MS);
	if (diff === 0) return 'Today';
	if (diff === 1) return 'Tomorrow';
	if (diff === -1) return 'Yesterday';
	const weekday = WEEKDAYS[parts.weekday]!;
	const weeks = weekIndex(parts.day) - weekIndex(today);
	if (weeks === 0) return weekday;
	if (weeks === 1 && diff > 0) return `Next ${weekday}`;
	if (weeks === -1 && diff < 0) return `Last ${weekday}`;
	const base = `${MONTHS[parts.month]} ${parts.date}`;
	return parts.year === now.getFullYear() ? base : `${base}, ${parts.year}`;
}

/** The text of a date mention: `Today`, `Next Friday, 9:00 AM`, `Nov 7 → Nov 9`. `null` for an invalid value. */
export function formatDateMention(value: DateValue, now: Date = new Date()): string | null {
	const start = partsOf(value.start);
	if (!start) return null;
	const end = value.end ? partsOf(value.end) : null;
	const withTime = (parts: Parts, day = true) =>
		`${day ? relativeDayLabel(parts, now) : ''}${parts.time ? `${day ? ', ' : ''}${formatTime(parts.time)}` : ''}`;
	if (!end) return withTime(start);
	// A range inside one day reads "Today, 9:00 AM → 10:00 AM".
	if (end.day === start.day && start.time && end.time) return `${withTime(start)} → ${withTime(end, false)}`;
	return `${withTime(start)} → ${withTime(end)}`;
}

/** `YYYY-MM-DD` of a local calendar day. */
export function isoDay(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** An ISO value for a local day and an optional `HH:mm` time: date-only without a time, else a UTC instant. */
export function composeIso(day: Date, time: string | null): string {
	if (!time) return isoDay(day);
	const [h, m] = time.split(':').map(Number);
	const local = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0, 0, 0);
	return local.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The local calendar day of an ISO value as a `Date` at local midnight, or `null`. */
export function dayOf(iso: string): Date | null {
	const parts = partsOf(iso);
	return parts ? new Date(parts.year, parts.month, parts.date) : null;
}

/** The local `HH:mm` of a timed ISO value, or `null` for a date-only one. */
export function timeOf(iso: string): string | null {
	const parts = partsOf(iso);
	return parts?.time ? `${String(parts.time.hours).padStart(2, '0')}:${String(parts.time.minutes).padStart(2, '0')}` : null;
}
