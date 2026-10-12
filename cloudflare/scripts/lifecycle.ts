// The R2 lifecycle rules the files buckets need (r2-lifecycle.json), as `cf r2 buckets lifecycle get` reports
// them: `uploads/` objects expire a day after they were written (a message copies its attachments into the
// conversation's own blobs first), and `static/`, where the Worker keeps earlier builds' hashed frontend files
// (src/http/assets.ts), 30 days after. scripts/resources.ts checks them before a deploy, scripts/reset.ts
// after it recreates a bucket.

export const UPLOADS_RULE = "Expire unattached uploads";
export const ARCHIVE_RULE = "Expire archived assets";
/** How long `static/` keeps an earlier build's files: a page open that long still finds its chunks. */
export const ARCHIVE_MAX_AGE = 30 * 86400;

export interface LifecycleRule {
	id: string;
	enabled?: boolean;
	conditions?: { prefix?: string };
	deleteObjectsTransition?: { condition?: { type?: string; maxAge?: number } };
}

/** The rule deleting uploads/ objects at most a day after they were written, enabled. */
export function expiresUploads(rule: LifecycleRule): boolean {
	const condition = rule.deleteObjectsTransition?.condition;
	return (
		rule.id === UPLOADS_RULE &&
		rule.enabled === true &&
		rule.conditions?.prefix === "uploads/" &&
		condition?.type === "Age" &&
		typeof condition.maxAge === "number" &&
		condition.maxAge > 0 &&
		condition.maxAge <= 86400
	);
}

/** The rule deleting static/ objects 30 days after they were written, enabled. */
export function expiresArchive(rule: LifecycleRule): boolean {
	const condition = rule.deleteObjectsTransition?.condition;
	return rule.id === ARCHIVE_RULE && rule.enabled === true && rule.conditions?.prefix === "static/" && condition?.type === "Age" && condition.maxAge === ARCHIVE_MAX_AGE;
}

/** What a bucket's rules lack, one line each; empty when both rules are in place. */
export function lifecycleProblems(bucket: string, rules: LifecycleRule[] | undefined): string[] {
	const problems: string[] = [];
	if (!rules?.some(expiresUploads)) problems.push(`R2 bucket ${bucket} lacks the enabled lifecycle rule that deletes uploads/ after a day (r2-lifecycle.json).`);
	if (!rules?.some(expiresArchive)) problems.push(`R2 bucket ${bucket} lacks the enabled lifecycle rule that deletes static/ after 30 days (r2-lifecycle.json).`);
	return problems;
}

/** A value with its object keys sorted, so that two rules compare equal whatever order cf lists their fields in. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
}

/**
 * The ids of a bucket's rules that are not exactly one of `own` (r2-lifecycle.json), every field compared:
 * the rules a reset, which recreates the bucket with `own`, would lose or change.
 */
export function lifecycleExtras(own: LifecycleRule[], rules: LifecycleRule[] | undefined): string[] {
	const known = new Set(own.map((rule) => JSON.stringify(canonical(rule))));
	return (rules ?? []).filter((rule) => !known.has(JSON.stringify(canonical(rule)))).map((rule) => rule.id);
}

/** Whether a bucket's rules are exactly `own`: none missing, none more, every field the same. */
export function lifecycleMatches(own: LifecycleRule[], rules: LifecycleRule[] | undefined): boolean {
	return lifecycleExtras(own, rules).length === 0 && lifecycleExtras(rules ?? [], own).length === 0;
}
