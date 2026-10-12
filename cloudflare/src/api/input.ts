// Request bodies and query strings of the JSON API, validated as Ninja validates them (web-api 8): after
// the auth checks and before the handler, 422 with Pydantic's error list (http/errors.ts). Unknown fields
// are ignored, as Ninja ignores them (`z.object`, which strips them; the frontend of an older version may
// still send `code_mode`). Strings are lib/schema.ts's `str`, which counts code points.

import { z } from "zod";
import { readOptionalJson } from "../http/body.ts";
import { HttpError, validationError, validationItems } from "../http/errors.ts";

/** The body, validated: an empty one is a missing payload, as Ninja answers (422 `missing` at body.payload). */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
	const body = await readOptionalJson(request);
	if (body === null) throw new HttpError(validationError([{ type: "missing", loc: ["body", "payload"], msg: "Field required" }]));
	const parsed = schema.safeParse(body.value);
	if (!parsed.success) throw new HttpError(validationError(validationItems(parsed.error.issues, "body", body.value)));
	return parsed.data;
}

/** The query string, validated. A parameter given more than once counts with its last value, as Django's `QueryDict[key]`. */
export function readQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
	const params = new URL(request.url).searchParams;
	// `fromEntries` defines own properties, so a parameter named `__proto__` stays an ordinary key.
	const data = Object.fromEntries([...new Set(params.keys())].map((key) => [key, params.getAll(key).at(-1) as string]));
	const parsed = schema.safeParse(data);
	if (!parsed.success) throw new HttpError(validationError(validationItems(parsed.error.issues, "query", data)));
	return parsed.data;
}

/** Pydantic's lax UUID: hyphenated, 32 digits, braced or `urn:uuid:`, any case; written lowercase and hyphenated, as the API writes ids. */
const UUID_FORMS = [
	/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
	/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i,
	/^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i,
	/^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
];

export function canonicalUuid(value: string): string | null {
	for (const form of UUID_FORMS) {
		const match = form.exec(value);
		if (match) return match.slice(1).join("-").toLowerCase();
	}
	return null;
}

/** A Pydantic `UUID` field. */
export function uuid(): z.ZodType<string, string> {
	return z.string().transform((value, ctx) => {
		const canonical = canonicalUuid(value);
		if (canonical !== null) return canonical;
		ctx.addIssue({ code: "invalid_format", format: "uuid", input: value, message: "Input should be a valid UUID" });
		return z.NEVER;
	});
}
