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

import type { Auth, Consent, OperationErrorShape, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP, defaultForbidden } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { parseQs, quoteSegment, urlsplitStrict } from "../../lib/urlsplit.ts";
import { type Reader, Invalid, isDict, list, model, nullable, optional, required, str } from "./model.ts";

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

/** Every character but letters, digits and `_.-~` percent-encoded (lib/urlsplit.ts). */
export const segment = quoteSegment;

/** JSON's text from bytes as `json.loads` reads UTF-8: a byte order mark skipped, invalid UTF-8 refused. */
export function jsonOf(bytes: Uint8Array): Json {
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	return parseJson(fromUtf8Strict(bytes.subarray(start)));
}

/**
 * Graph's error code from an error body, if it names one. The body is read as `response.json()` reads it, from
 * its bytes: one that is not UTF-8, or not JSON, names nothing.
 */
export function errorCode(bytes: Uint8Array): string | null {
	let parsed: Json;
	try {
		parsed = jsonOf(bytes);
	} catch {
		return null;
	}
	// `response.json().get("error", {}).get("code")`: a body that is not an object, or an error that is not
	// one, names nothing.
	if (!isDict(parsed)) return null;
	const error = Object.hasOwn(parsed, "error") ? parsed.error : {};
	if (!isDict(error)) return null;
	const code = Object.hasOwn(error, "code") ? error.code : null;
	return typeof code === "string" ? code : null;
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

export const User = model({
	id: required(str),
	display_name: optional(nullable(str), null),
	mail: optional(nullable(str), null),
	user_principal_name: optional(nullable(str), null),
	proxy_addresses: optional(list(str), []),
});
export type User = ReturnType<typeof User>;

/** The query parameter a cursor stands for, or INVALID_CURSOR. */
export function pageParam(cursor: string): { [name: string]: string } {
	const at = cursor.indexOf(":");
	const kind = at < 0 ? cursor : cursor.slice(0, at);
	const value = at < 0 ? "" : cursor.slice(at + 1);
	if (kind === "skip" && SKIP.test(value)) return { $skip: value };
	if (kind === "token" && SKIPTOKEN.test(value)) return { $skiptoken: value };
	throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
}

/**
 * `parse_qs(urlsplit(url).query)`: the URL split as `urlsplit` splits it (refused with UrlError where it
 * throws), then the query split on `&`, pairs without `=` or with an empty value left out,
 * `+` read as a space and `%XX` unquoted (lib/urlsplit.ts).
 */
export function queryOf(url: string): Map<string, string[]> {
	return parseQs(urlsplitStrict(url).query);
}

/** The cursor for Graph's next page, taken out of its nextLink; the link itself is never requested. */
export function nextCursor(nextLink: unknown): string | null {
	if (nextLink === null || nextLink === undefined) return null;
	const unusable = new OperationError("PROVIDER_LIMIT", "Microsoft Graph returned a page link Minerva cannot use.");
	if (typeof nextLink !== "string" || nextLink.length > 4000) throw unusable;
	const query = queryOf(nextLink);
	const token = query.get("$skiptoken");
	const skip = query.get("$skip");
	if (token !== undefined && token.length === 1 && skip === undefined && SKIPTOKEN.test(token[0] as string)) return `token:${token[0]}`;
	if (skip !== undefined && skip.length === 1 && token === undefined && SKIP.test(skip[0] as string)) return `skip:${skip[0]}`;
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

	async get(path: string, options: { params?: { [name: string]: string }; prefer?: string } = {}): Promise<{ [key: string]: Json }> {
		const response = await this.http.bounded(
			{ method: "GET", path, ...(options.params === undefined ? {} : { query: options.params }), headers: { Prefer: options.prefer ?? IMMUTABLE_IDS } },
			MAX_RESPONSE_BYTES,
			new OperationError("RESPONSE_TOO_LARGE", `${this.provider} returned more than Minerva reads.`),
		);
		let body: Json;
		try {
			body = jsonOf(new Uint8Array(await response.arrayBuffer()));
		} catch (error) {
			throw this.unexpected(error);
		}
		if (!isDict(body)) throw this.unexpected();
		return body as { [key: string]: Json };
	}

	parse<T>(reader: Reader<T>, value: unknown): T {
		try {
			return reader(value);
		} catch (error) {
			if (error instanceof Invalid) throw this.unexpected(error);
			throw error;
		}
	}

	page<T>(reader: Reader<T>, body: { [key: string]: Json }): [T[], string | null] {
		const items = Object.hasOwn(body, "value") ? body.value : undefined;
		if (!Array.isArray(items)) throw this.unexpected();
		return [items.map((item) => this.parse(reader, item)), nextCursor(Object.hasOwn(body, "@odata.nextLink") ? body["@odata.nextLink"] : null)];
	}

	async me(): Promise<User> {
		return this.parse(User, await this.get("/me", { params: { $select: "id,displayName,mail,userPrincipalName" } }));
	}
}

/** The label of an account as every Microsoft connector shows it. */
export function accountLabel(user: User, fallback: string): string {
	return user.mail || user.user_principal_name || user.display_name || fallback;
}
