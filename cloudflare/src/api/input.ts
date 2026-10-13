// Request bodies and query strings of the JSON API, validated after the auth checks and before the
// handler: 422 with zod's issues (http/errors.ts). Unknown fields are ignored (`z.object`, which strips
// them; the frontend of an older version may still send `code_mode`).

import { z } from "zod";
import { readJson } from "../http/body.ts";
import { HttpError, refused, validationError, validationItems } from "../http/errors.ts";

/** The body (http/body.ts `readJson`: 415, 413 or 400), validated: an empty one is a 422 at `body`. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
	const body = await readJson(request);
	if (!body.ok) throw new HttpError(refused(body.refusal.code, body.refusal.detail));
	if (body.value === undefined) throw new HttpError(validationError([{ type: "invalid_type", loc: ["body"], msg: "Invalid input: expected a JSON body" }]));
	const parsed = schema.safeParse(body.value);
	if (!parsed.success) throw new HttpError(validationError(validationItems(parsed.error.issues, "body")));
	return parsed.data;
}

/** The query string, validated. A parameter given more than once counts with its last value. */
export function readQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
	const params = new URL(request.url).searchParams;
	// `fromEntries` defines own properties, so a parameter named `__proto__` stays an ordinary key.
	const data = Object.fromEntries([...new Set(params.keys())].map((key) => [key, params.getAll(key).at(-1) as string]));
	const parsed = schema.safeParse(data);
	if (!parsed.success) throw new HttpError(validationError(validationItems(parsed.error.issues, "query")));
	return parsed.data;
}

export { canonicalUuid, uuid } from "@minerva/contract";
