// What Microsoft connectors share: one Entra app,
// Graph consent, and a Graph client base.
//
// Minerva connects with delegated permissions through one Entra app for work, school and personal accounts
// (the `common` endpoint). Every connector asks for `offline_access User.Read` and its own scopes, and each
// has its own callback URL on the app.
//
// Graph pages with an `@odata.nextLink` URL. Minerva never requests that URL: it takes only the paging
// parameter out of it (`$skip` or `$skiptoken`), checks it, and rebuilds the request itself. Graph's own
// error texts never reach the model.

import { z } from "zod";
import type { Auth, Consent, OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP, defaultForbidden } from "../../gateway/http.ts";
import { isDict, type Json, type JsonObject, parseJsonBytes } from "../../lib/json.ts";

export const GRAPH = "https://graph.microsoft.com";
export const API_URL = `${GRAPH}/v1.0`;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const IMMUTABLE_IDS = 'IdType="ImmutableId"';
/** Graph's ids are URL-safe base64. */
export const ID = /^[A-Za-z0-9=_-]{10,512}$/;
const SKIP = /^\d{1,6}$/u;
const SKIPTOKEN = /^[A-Za-z0-9._~=+/%:-]{1,880}$/;
/** The mailbox exists but Graph cannot reach it: on-premises Exchange, or an inactive account. */
export const UNSUPPORTED_MAILBOX: ReadonlySet<string> = new Set(["MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI"]);

export type OAuth2 = Extract<Auth, { type: "oauth2" }>;

export function oauth(...scopes: string[]): OAuth2 {
	return {
		type: "oauth2",
		app: "microsoft",
		authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		scopes: ["offline_access", "User.Read", ...scopes],
		authorizeParams: [["prompt", "select_account"]],
	};
}

/**
 * Any of these Graph scopes, the first as requested. Microsoft reports granted scopes in their short form,
 * or prefixed with Graph's URL, and not always in the case they were requested in.
 */
export function consent(...scopes: string[]): Consent {
	const spellings = scopes.flatMap((scope) => [scope, `${GRAPH}/${scope}`]);
	const all = [...spellings, ...spellings.map((form) => form.toLowerCase())];
	return [...new Set(all)].map((form) => [form]);
}

/** All of these Graph scopes together, each in any of the spellings `consent` accepts. */
export function consentAll(...scopes: string[]): Consent {
	let options: string[][] = [[]];
	for (const scope of scopes) {
		options = options.flatMap((option) => consent(scope).map((spelling) => [...new Set([...option, ...spelling])]));
	}
	return options;
}

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });

/** Graph's error code from an error body, if it names one: a body that is not UTF-8, not JSON or not so shaped names nothing. */
export function errorCode(bytes: Uint8Array): string | null {
	let parsed: Json;
	try {
		parsed = parseJsonBytes(bytes);
	} catch {
		return null;
	}
	const found = ErrorBody.safeParse(parsed);
	return found.success ? found.data.error.code : null;
}

export type Classify = (provider: string, response: Response, body: string, bytes: Uint8Array) => OperationErrorShape | null;

export const classify: Classify = (provider, response, _body, bytes) => {
	const code = errorCode(bytes);
	if (code !== null && UNSUPPORTED_MAILBOX.has(code)) {
		return new OperationError(
			"UNSUPPORTED_ACCOUNT",
			`This account has no mailbox ${provider} lets Minerva use (for example, it is hosted on an on-premises Exchange server).`,
		);
	}
	// Graph throttles with 503 as well as 429.
	if (response.status === 503) return new OperationError("PROVIDER_RATE_LIMITED", `${provider} is rate limiting requests. Try again later.`);
	return null;
};

export const User = z.object({
	id: z.string(),
	displayName: z.string().nullable().default(null),
	mail: z.string().nullable().default(null),
	userPrincipalName: z.string().nullable().default(null),
	proxyAddresses: z.array(z.string()).default([]),
});
export type User = z.output<typeof User>;

/** The query parameter a cursor stands for, or INVALID_CURSOR. */
export function pageParam(cursor: string): { [name: string]: string } {
	const at = cursor.indexOf(":");
	const kind = at < 0 ? cursor : cursor.slice(0, at);
	const value = at < 0 ? "" : cursor.slice(at + 1);
	if (kind === "skip" && SKIP.test(value)) return { $skip: value };
	if (kind === "token" && SKIPTOKEN.test(value)) return { $skiptoken: value };
	throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
}

/** The query parameters of a page link Graph sent; none when it is no URL. */
export function queryOf(link: string): URLSearchParams {
	return URL.parse(link, GRAPH)?.searchParams ?? new URLSearchParams();
}

/** The cursor for Graph's next page, taken out of its nextLink; the link itself is never requested. */
export function nextCursor(nextLink: string | null): string | null {
	if (nextLink === null) return null;
	const unusable = new OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.");
	if (nextLink.length > 4000) throw unusable;
	const query = queryOf(nextLink);
	const token = query.getAll("$skiptoken");
	const skip = query.getAll("$skip");
	if (token.length === 1 && skip.length === 0 && SKIPTOKEN.test(token[0] as string)) return `token:${token[0]}`;
	if (skip.length === 1 && token.length === 0 && SKIP.test(skip[0] as string)) return `skip:${skip[0]}`;
	throw unusable;
}

export interface GraphOptions {
	baseUrl?: string;
	classify?: Classify;
}

/** Base of the Graph clients: authenticated, bounded reads, validated responses. */
export class Graph implements ProviderClient {
	readonly provider: string;
	readonly http: ProviderHTTP;

	constructor(provider: string, accessToken: string, io: ProviderIo, options: GraphOptions = {}) {
		this.provider = provider;
		this.http = new ProviderHTTP(io, {
			provider,
			baseUrl: options.baseUrl ?? API_URL,
			headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", Prefer: IMMUTABLE_IDS },
			forbidden: defaultForbidden,
			classify: options.classify ?? classify,
		});
	}

	async close(): Promise<void> {
		await this.http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.http.unexpected(cause);
	}

	async get(path: string, options: { params?: { [name: string]: string }; prefer?: string } = {}): Promise<JsonObject> {
		const response = await this.http.bounded(
			{ method: "GET", path, ...(options.params === undefined ? {} : { query: options.params }), headers: { Prefer: options.prefer ?? IMMUTABLE_IDS } },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", `${this.provider} returned more than Minerva reads.`),
		);
		let body: Json;
		try {
			body = parseJsonBytes(await response.arrayBuffer());
		} catch (error) {
			throw this.unexpected(error);
		}
		if (!isDict(body)) throw this.unexpected();
		return body;
	}

	/** `value` read with `schema`; one that does not fit is an unexpected response. */
	parse<T>(schema: z.ZodType<T>, value: unknown): T {
		const found = schema.safeParse(value);
		if (!found.success) throw this.unexpected(found.error);
		return found.data;
	}

	/** A page of a Graph list: its items, and the cursor `next` takes out of its `@odata.nextLink`. */
	page<T>(schema: z.ZodType<T>, body: JsonObject, next: (link: string | null) => string | null = nextCursor): [T[], string | null] {
		const page = this.parse(z.object({ value: z.array(schema), "@odata.nextLink": z.string().nullable().default(null) }), body);
		return [page.value, next(page["@odata.nextLink"])];
	}

	async me(): Promise<User> {
		return this.parse(User, await this.get("/me", { params: { $select: "id,displayName,mail,userPrincipalName" } }));
	}
}

/** The label of an account as every Microsoft connector shows it. */
export function accountLabel(user: User, fallback: string): string {
	return user.mail || user.userPrincipalName || user.displayName || fallback;
}
