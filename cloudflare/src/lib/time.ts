// Times as the API and the model see them. Stored times are milliseconds since the epoch.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** ISO 8601 in UTC with a `Z`, as the API writes datetimes (any ISO form works for the frontend). */
export function isoTime(ms: number): string {
	return new Date(ms).toISOString();
}

/** Seconds since the epoch as a float, as allauth writes `at` in authentication records. */
export function epochSeconds(ms: number): number {
	return ms / 1000;
}

/** `Monday, 2026-10-10 14:03`, the run's start in the instructions' "The run started on … UTC." (runs spec 3.4). */
export function runStartLabel(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	return `${DAYS[date.getUTCDay()]}, ${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
