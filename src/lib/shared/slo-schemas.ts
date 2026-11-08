/** The SLO report: the operating targets of docs/PLAN.md "Security and reliability", measured from Analytics Engine. */
import * as v from 'valibot';
import { isoSchema } from './schemas.js';

/** One row of the operating-targets table, in the order the dashboard shows them. */
export const SLO_IDS = ['rpc_availability', 'edit_to_diff', 'reconnects', 'queue_lag', 'do_storage', 'page_size'] as const;
export type SloId = (typeof SLO_IDS)[number];

export const sloSignalSchema = v.object({
	id: v.picklist(SLO_IDS),
	label: v.string(),
	/** The target, as the table words it ("99.9% per month"). */
	target: v.string(),
	/** What raises an alert ("error rate above 1% for 5 minutes"). */
	alertWhen: v.string(),
	/** The current value, formatted ("0.04% errors"). */
	display: v.string(),
	value: v.nullable(v.number()),
	unit: v.picklist(['percent', 'ms', 'bytes', 'ratio', 'count']),
	/** `breach`: the alert condition holds now; `nodata`: nothing measured in the window. */
	status: v.picklist(['ok', 'breach', 'nodata']),
	/** A second line: the worst workspace or page, the window, a query error. */
	detail: v.optional(v.string()),
	/** The last 24 hours, hourly (`t` in unix seconds). */
	series: v.array(v.object({ t: v.number(), v: v.number() }))
});
export type SloSignal = v.InferOutput<typeof sloSignalSchema>;

export const sloReportSchema = v.object({
	/** False when the Analytics Engine SQL API is not configured (`ANALYTICS_API_TOKEN`): `message` says what to set. */
	available: v.boolean(),
	message: v.optional(v.string()),
	generatedAt: isoSchema,
	signals: v.array(sloSignalSchema)
});
export type SloReport = v.InferOutput<typeof sloReportSchema>;
