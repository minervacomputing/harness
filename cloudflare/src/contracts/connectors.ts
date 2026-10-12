// The connector contract, ported from backend/connectors/base.py and http.py (connectors 1, 7.6, 9, 11).
// A connector declares resource kinds, the actions on them, how it authenticates and its operations. Each
// operation validates its input strictly and declares the (kind, action) pairs it needs; `prepare()`
// resolves the real resources a call touches before anything is authorized; returned records carry their
// actual resource, so results are filtered after the call. Provider knowledge lives in connectors; the
// generic rules live in the executor, which checks every declaration at runtime.

import type { z } from "zod";
import type { ConnectionId, Json } from "./common.ts";
import type { Resource } from "./policy.ts";

/** The reserved kind for account-level actions; its one resource id is the connection id. */
export type AccountKind = "account";

export interface ActionSpec {
	id: string;
	label: string;
	/** One action that must also be allowed on the same resource (create requires read). */
	requires?: string | null;
}

export interface ResourceKind {
	id: string;
	label: string;
	actions: string[];
	/** One grant (`*`) may cover every resource of the kind, including new ones. Default false. */
	wildcard?: boolean;
	/** Resources nest; a grant covers what is inside, and resources carry their ancestors. Default false. */
	hierarchical?: boolean;
	/** Shown with the kind where users choose access. */
	note?: string | null;
	/** Whether discovery lists resources without a search; otherwise users search. Default true. */
	listed?: boolean;
}

/**
 * The call touches this concrete resource and needs this action (and its `requires` chain) on it.
 * `enumerate`: a listing that passes if some resource of the kind could be allowed; its records are then
 * filtered one by one. Writes never enumerate (connectors 1.3).
 */
export type Requirement = { need: Resource; action: string } | { enumerate: string; action: string };

export interface ScopedRecord {
	resource: Resource;
	data: { [key: string]: Json };
}

export interface ProviderOutput {
	records: ScopedRecord[];
	/** The provider's own cursor; the executor turns it into a run-bound page token. */
	nextCursor?: string | null;
	/** The provider said it did not search everything it could have. */
	incomplete?: boolean;
}

export interface Prepared {
	requirements: Requirement[];
	/** Runs only after authorization. A mutating operation sends its one write from here. */
	execute(): Promise<ProviderOutput>;
}

/** One connection as one call sees it: its id and an authenticated provider client. */
export interface Binding<Client = ProviderClient> {
	connectionId: ConnectionId;
	client: Client;
	/** A resource on this connection; ancestors nearest first. */
	resource(kind: string, id: string, within?: string[], partial?: boolean): Resource;
	/** The connection itself, as an `account` resource. */
	account(): Resource;
}

/**
 * Provider scopes an operation works with: any one of these sets, granted in full; the first is the one
 * requested. Unknown scopes (`null`) pass every check, so the provider refuses; `[]` (known, none) fails
 * every operation with consent (connectors 11.7, risk 16).
 */
export type Consent = string[][];

export interface Operation<Input = Json> {
	/** Lowercase words joined by underscores, no digits; `<slug>99_<name>` fits in 64 characters. */
	name: string;
	title: string;
	/** Model-facing; not part of the fingerprint (field descriptions are, through the schema). */
	description: string;
	/**
	 * Strict input: unknown fields refused (the model must never pick a connection), no coercion, every
	 * string stripped before its limits. `null` or missing arguments validate as `{}`. The executor hashes the
	 * normalized output, defaults included (connectors 1.2). Its JSON Schema, zod's own of the input with
	 * zod pinned (gateway/registry.ts `inputSchema`), is what the model sees and what the fingerprint
	 * covers. The registry refuses an input that is not strict at every depth, as Pydantic's config applies
	 * to nested models too (gateway/registry.ts `checkStrict`): every object `z.strictObject`, every
	 * `dict[str, …]` `strictRecord` or `anyRecord` (never `z.record`, which mishandles a "__proto__" key),
	 * every string `strippedStr`, no `z.coerce`, no transform before validation.
	 *
	 * Strings are `strippedStr({min, max})` from lib/schema.ts, never zod's `.trim()`, `.min()` or `.max()`:
	 * Pydantic strips Unicode White_Space (U+0085 included, U+FEFF not) and counts code points, so an emoji
	 * is one character, and the normalized arguments (and the write keys hashed from them) stay today's.
	 * The arguments are parsed from the model's text with `parseJson` (lib/json.ts), not `JSON.parse`.
	 */
	input: z.ZodType<Input>;
	prepare(binding: Binding, input: Input): Promise<Prepared>;
	/** Every (kind, action) pair the operation can need; requirements at runtime must cover exactly these. */
	needs: [kind: string, action: string][];
	/** The action each returned record must allow on its own resource. Default `read`. */
	outputAction?: string;
	consent?: Consent | null;
	/** Bump when the meaning changes in a way the declaration does not show. Default 1. */
	revision?: number;
	mutates?: boolean;
	/** The input has `cursor`; the output may have `nextCursor`. */
	paginated?: boolean;
}

export type Auth =
	| {
			type: "oauth2";
			/** The operator's client: MINERVA_<APP>_CLIENT_ID and _SECRET; several connectors may share one. */
			app: string;
			authorizeUrl: string;
			tokenUrl: string;
			scopes: string[];
			/** Default " "; Linear and Slack use ",". */
			scopeSeparator?: string;
			/** Dynamic client registration when the operator configured no client (Todoist). */
			registrationUrl?: string | null;
			/** Sent first, in order; none may be a protocol parameter. */
			authorizeParams?: [string, string][];
			/** Send `login_hint` with the account id on reconnect. Default false. */
			loginHint?: boolean;
			/** Default "post" (client id and secret in the body, before the other fields). */
			clientAuth?: "post" | "basic";
			/** Token requests as JSON instead of a form. Default false. */
			jsonBody?: boolean;
			/** Default true. */
			pkce?: boolean;
	  }
	| { type: "api_key"; label: string; hint?: string | null }
	| { type: "builtin" };

export interface Account {
	id: string;
	label: string;
}

export interface DiscoveryItem {
	id: string;
	name: string;
	/** `children` may list resources inside this one. */
	expandable?: boolean;
}

export interface DiscoveryPage {
	items: DiscoveryItem[];
	/** The provider's cursor; the browser holds it, so connectors validate it as strictly as tool input. */
	nextCursor?: string | null;
}

/** A provider client, owned by one request and closed after it. */
export interface ProviderClient {
	close(): Promise<void>;
}

export interface Connector<Client extends ProviderClient = ProviderClient> {
	slug: string;
	name: string;
	kinds: ResourceKind[];
	actions: ActionSpec[];
	auth: Auth;
	/** Each declared with `defineOperation` (gateway/connector.ts), which keeps its input's type for `prepare`. */
	operations: Operation<never>[];
	/** Hierarchical kinds users browse as a tree with `children`; not part of the fingerprint. */
	browsable?: string[];
	/** `secret`: the API key, the OAuth access token, or "" for a built-in service. */
	client(secret: string, io: ProviderIo): Client;
	account(client: Client): Promise<Account>;
	discover(client: Client, kind: string, options: { query: string | null; cursor: string | null }): Promise<DiscoveryPage>;
	/** `parent` is user input: check it as strictly as a tool would. Only for browsable kinds. */
	children?(client: Client, kind: string, parent: string | null, options: { cursor: string | null }): Promise<DiscoveryPage>;
	/** Names of the given resources; ones the account cannot see are left out. */
	describe(client: Client, kind: string, ids: string[]): Promise<{ [id: string]: string }>;
	/** Whether this instance can run the operation at all (say, an operator key is set). Default true. */
	offered?(operation: Operation<never>): boolean;
	/** A (label, URL) where the user manages what the provider lets Minerva reach. */
	manageLink?(): [label: string, url: string] | null;
}

/** Errors the core raises (connectors 1.5). Only an error's message reaches the model or the UI. */
export type CoreErrorCode =
	| "POLICY_DENIED"
	| "INVALID_ARGUMENTS"
	| "UNKNOWN_OPERATION"
	| "OPERATION_CHANGED"
	| "CONSENT_REQUIRED"
	| "CONNECTOR_ERROR"
	| "RUN_ENDED"
	| "WRITE_UNCERTAIN"
	| "WRITE_IN_PROGRESS"
	| "LIMIT_REACHED"
	| "INVALID_CURSOR"
	| "TIMED_OUT"
	| "PROVIDER_UNAVAILABLE"
	| "CONNECTION_UNAUTHORIZED"
	| "PROVIDER_FORBIDDEN"
	| "NOT_FOUND"
	| "PROVIDER_RATE_LIMITED"
	| "PROVIDER_REJECTED"
	| "PROVIDER_FAILED"
	| "FILE_TOO_LARGE"
	| "INVALID_ADDRESS"
	/** Any error that is not an operation error; its message is the generic one (runs 5.3). */
	| "FAILED";

/** Errors connectors raise (connectors 1.5). */
export type ConnectorErrorCode =
	| "PROVIDER_LIMIT"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_URL"
	| "UNSUPPORTED_FILE"
	| "UNSUPPORTED_ACCOUNT"
	| "UNSUPPORTED_MESSAGE"
	| "UNSUPPORTED_CONTENT"
	| "UNSUPPORTED_RECIPIENT"
	| "UNSUPPORTED_PAGE"
	| "UNSUPPORTED_DATABASE"
	| "SITE_UNREACHABLE"
	| "SITE_TIMEOUT"
	| "SITE_NOT_PUBLIC"
	| "PAGE_TOO_LARGE"
	| "PAGE_ERROR"
	| "WRITE_UNCONFIRMED"
	| "EDIT_NOT_APPLIED"
	| "FILE_MOVED"
	| "PAGE_MOVED"
	| "ISSUE_MOVED"
	| "TEAM_MOVED"
	| "MAIL_MOVED"
	| "CHANNEL_MOVED"
	| "DEAL_MOVED"
	| "CONVERSATION_MOVED"
	| "MESSAGE_CHANGED"
	| "PAYMENT_CHANGED"
	| "CHANNEL_ARCHIVED"
	| "PIPELINE_ARCHIVED"
	| "NOT_IN_CHANNEL"
	| "EXTERNAL_CHANNEL"
	| "LINK_NOT_ALLOWED"
	| "STATUS_CHANGE_REFUSED"
	| "REFUND_REFUSED"
	| "CURRENCY_MISMATCH"
	| "INVALID_STAGE"
	| "INVALID_KEY"
	| "SEARCH_UNAVAILABLE"
	| "PROVIDER_NOT_CONFIGURED"
	| "NOT_SUPPORTED";

export type ErrorCode = CoreErrorCode | ConnectorErrorCode;

/**
 * An owned, deliberately safe error: `{code, message}` (gateway/connector.ts has the class, `OperationError`,
 * and `denied()`: POLICY_DENIED "This resource or action is not available under the current permissions.",
 * also for what Minerva will not reveal). Any other exception is logged and the model sees "The
 * operation could not be completed. Check the connection and try again." (code FAILED).
 */
export interface OperationErrorShape {
	code: ErrorCode;
	message: string;
}

// Provider HTTP (connectors 7.6). Step 2 implements `ProviderHttp` over `fetch`; connectors build their
// clients on it.

/**
 * What a write did to the provider. Starts unknown when sent: 2xx is applied; 400, 401, 403, 404, 409,
 * 412, 422 and 429 are not applied (refused); anything else (5xx, 418, 3xx) and every transport error stay
 * unknown, since `fetch` cannot tell "never connected" from "dropped after sending" (connectors risk 9).
 */
export type Effect = "not_applied" | "applied" | "unknown";

/**
 * The one write a mutating operation may send, opened by the executor around `execute()` with the deadline
 * fixed at dispatch (a monotonic `performance.now()` instant). A request after the attempt is closed (a
 * promise the connector left running) is refused (connectors 7.6, risk 7).
 */
export interface WriteAttempt {
	readonly deadline: number;
	sent: boolean;
	effect: Effect | null;
	closed: boolean;
}

/** What the executor hands a connector's client: `fetch` (injected in tests) and the open write attempt. */
export interface ProviderIo {
	fetch: typeof fetch;
	/** The write attempt the executor opened for this call's `execute()`, or null outside it. */
	currentWrite(): WriteAttempt | null;
	/** Monotonic milliseconds, for write deadlines. */
	now(): number;
}

export interface ProviderRequest {
	method: string;
	/** Relative to the client's base URL. */
	path: string;
	query?: { [name: string]: string | number | boolean | null | undefined };
	headers?: { [name: string]: string };
	json?: Json;
	form?: { [name: string]: string };
	body?: BodyInit;
	/** Whether the request writes. Defaults to POST, PUT, PATCH and DELETE; a read sent with POST passes false. */
	mutating?: boolean;
	/** Return a 3xx for the caller to judge instead of failing. Never for a write. */
	redirects?: boolean;
}

/**
 * A provider's HTTP client (http.py `ProviderHTTP`). Never follows redirects (`redirect: "manual"`).
 * Allows one mutating request, only inside an open write attempt, only with at least 2 s left (else
 * TIMED_OUT, not sent), with a timeout of min(20 s, time left). Maps errors: `classify` first, then 401
 * CONNECTION_UNAUTHORIZED "The {provider} connection is no longer authorized.", 403 `forbidden` (default
 * PROVIDER_FORBIDDEN "{provider} refused this request for the connected account."), 404 NOT_FOUND "{provider}
 * did not find this object.", 429 PROVIDER_RATE_LIMITED "{provider} is rate limiting requests. Try again
 * later.", other 4xx PROVIDER_REJECTED "{provider} rejected this request.", anything else PROVIDER_FAILED
 * "{provider} could not complete this request."; a transport error is PROVIDER_UNAVAILABLE "{provider}
 * could not be reached." `judge` decides a write's effect before the status does.
 */
export interface ProviderHttp {
	readonly provider: string;
	request(request: ProviderRequest): Promise<Response>;
	/** The body as JSON; a body that does not parse is PROVIDER_FAILED "{provider} returned an unexpected response." */
	json(request: ProviderRequest): Promise<Json>;
	/** The body validated by a schema; a mismatch is the same unexpected-response error. */
	parsed<T>(request: ProviderRequest, schema: z.ZodType<T>): Promise<T>;
	/**
	 * The body streamed up to `limit` bytes; more raises `tooLarge`. An error response is read up to 64 KiB
	 * and mapped with only content-type, retry-after and x-ratelimit-* kept. Never accounted as a write.
	 */
	bounded(request: ProviderRequest, limit: number, tooLarge: OperationErrorShape): Promise<Response>;
	/** `bounded` with FILE_TOO_LARGE "This file is larger than Minerva reads ({limit} bytes)." */
	download(request: ProviderRequest, limit: number): Promise<Response>;
}

export interface ProviderHttpOptions {
	provider: string;
	baseUrl: string;
	headers: { [name: string]: string };
	/** Seconds; default 20. */
	timeout?: number;
	forbidden?(provider: string, response: Response): OperationErrorShape;
	/**
	 * Names the error for a failed response when its status does not; null keeps the status's meaning.
	 * `body` is the text decoded with replacement characters; `bytes` what was received, for a connector
	 * that reads it as Python's `response.json()` does, which refuses invalid UTF-8.
	 */
	classify?(provider: string, response: Response, body: string, bytes: Uint8Array): OperationErrorShape | null;
	/**
	 * What a response did to a write when its status does not tell (GraphQL answers failures with 200); null
	 * goes by the status. `body` and `bytes` as for `classify`.
	 */
	judge?(response: Response, body: string, bytes: Uint8Array): Effect | null;
}

// Credentials (connectors 9.1). Existing ciphertext decrypts to these payloads.

export type CredentialPayload =
	| {
			kind: "oauth2";
			access_token: string;
			refresh_token: string | null;
			/** Sorted, unique; null when unknown (consent checks then pass). */
			scopes: string[] | null;
			/** Epoch seconds; set only from an integer `expires_in` under a year. */
			expires_at?: number;
			/** The client that issued the tokens; refresh and reconnect go only through it. */
			client_id?: string;
			/** The endpoint that issued them; refresh tokens are only ever sent there. */
			token_url?: string;
	  }
	| { kind: "api_key"; key: string }
	| { kind: "builtin" };
