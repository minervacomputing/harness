// The connector contract: the declaration every connector makes and the runtime parts around it.
// A connector declares resource kinds, the actions on them, how it authenticates and its operations. Each
// operation validates its input strictly and declares the (kind, action) pairs it needs; `prepare()`
// resolves the real resources a call touches before anything is authorized; returned records carry their
// actual resource, so results are filtered after the call. Provider knowledge lives in connectors; the
// generic rules live in the executor, and the registry (registry.ts) checks every declaration.
//
// The runtime parts: lookups on a declaration, the defaults of an operation, consent, bindings and the
// owned error.

import type { ImageContent } from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { Json } from "../lib/json.ts";
import type { ConnectionId } from "../shared/rpc.ts";
import type { ProviderIo } from "./http.ts";
import { type Resource, resource } from "./policy.ts";

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
 * filtered one by one. Writes never enumerate.
 */
export type Requirement = { need: Resource; action: string } | { enumerate: string; action: string };

export interface ScopedRecord {
	resource: Resource;
	data: { [key: string]: Json };
	/** Its `data` in base64. Shown to the model with its record, for an operation that declares `images`. */
	image?: ImageContent;
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
 * every operation with consent.
 */
export type Consent = string[][];

export interface Operation<Input = Json> {
	/** Lowercase words joined by underscores, no digits; `<slug>99_<name>` fits in 64 characters. */
	name: string;
	title: string;
	/** Model-facing; not part of the fingerprint (field descriptions are, through the schema). */
	description: string;
	/**
	 * Strict input: unknown fields refused at every depth (the model must never pick a connection), no
	 * coercion, no transform before validation. `null` or missing arguments validate as `{}`. The executor
	 * hashes the normalized output, defaults included. Its JSON Schema, zod's own of the input with zod
	 * pinned (registry.ts `inputSchema`), is what the model sees and what the fingerprint covers.
	 * The registry refuses an input that is not strict at every depth (registry.ts `checkStrict`):
	 * every object `z.strictObject`, every record lib/schema.ts's `record` (never `z.record`, which drops a
	 * "__proto__" key), no `z.coerce`. Strings are usually `z.string().trim()` with their limits. The
	 * arguments are parsed from the model's text with `parseJson` (lib/json.ts), not `JSON.parse`.
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
	/** Its records may carry an image (`ScopedRecord.image`). */
	images?: boolean;
}

export type Auth =
	| {
			type: "oauth2";
			/** The OAuth app whose client Laravel holds; several connectors may share one. */
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

/** A tenant as `describeAccount` names it (Tenancy): its id, compared exactly, and its name for people. */
export interface Tenant {
	id: string;
	name: string;
}

/**
 * How a connector's resources belong to organizations, which connection policies limit.
 * `account`: a token reaches one tenant, which `account()` names. `resource`: a token reaches several, so every resource it
 * resolves or returns and every item discovery lists names its `tenant`, from what the provider answered for that call, and
 * `tenants` names those of resources a grant edit allows, leaving out any it cannot place. `unknown`: a policy can only offer
 * the connector or not.
 */
export type Tenancy<Client = ProviderClient> =
	| { kind: "account"; label: string }
	| { kind: "resource"; label: string; tenants(client: Client, kind: string, ids: string[]): Promise<{ [id: string]: string }> }
	| { kind: "unknown" };

export interface Account {
	id: string;
	label: string;
	/**
	 * The tenants it reaches now: for a connector with a tenant per account its one tenant, or none (a personal Google account);
	 * for one with a tenant per resource, those it can list. Absent: none.
	 */
	tenants?: Tenant[];
}

export interface DiscoveryItem {
	id: string;
	name: string;
	/** Its tenant, for a connector with a tenant per resource. */
	tenant?: string;
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
	tenancy: Tenancy<Client>;
	/** Each declared with `defineOperation` (below), which keeps its input's type for `prepare`. */
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
	/** A (label, URL) where the user manages what the provider lets Minerva reach. */
	manageLink?(): [label: string, url: string] | null;
}

/** Errors the core raises. Only an error's message reaches the model or the UI. */
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
	/** Any error that is not an operation error; its message is the generic one. */
	| "FAILED";

/** Errors connectors raise. */
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
	| "SITE_TIMEOUT"
	| "PAGE_TOO_LARGE"
	| "PAGE_ERROR"
	| "BROWSER_BUSY"
	| "BROWSER_UNAVAILABLE"
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
	| "PROVIDER_NOT_CONFIGURED"
	| "NOT_SUPPORTED";

export type ErrorCode = CoreErrorCode | ConnectorErrorCode;

/**
 * An owned, deliberately safe error: `{code, message}` (`OperationError` below, and `denied()` for
 * POLICY_DENIED, also for what Minerva will not reveal). Any other exception is logged and the model sees
 * "The operation could not be completed. Check the connection and try again." (code FAILED).
 */
export interface OperationErrorShape {
	code: ErrorCode;
	message: string;
}

/** A connection's credentials: what Laravel lends for one call. */
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

/** A reserved kind for account-level actions; its one resource id is the connection id. */
export const ACCOUNT_KIND = "account";

/** An owned, deliberately safe error. Only these messages reach the model or the UI. */
export class OperationError extends Error implements OperationErrorShape {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OperationError";
		this.code = code;
	}
}

export const DENIED = "This resource or action is not available under the current permissions.";

/** The refusal of a call the policy does not allow, or of one naming something Minerva will not reveal. */
export function denied(): OperationError {
	return new OperationError("POLICY_DENIED", DENIED);
}

/**
 * An operation declared with its input's type, for a connector's `operations` (`Operation<never>[]`). The
 * cast is the one place the input type is forgotten: zod's schema type is covariant in its output, so no
 * typed schema is a `ZodType<never>`. The executor only ever passes `prepare` what `input` parsed.
 */
export function defineOperation<Input>(op: Operation<Input>): Operation<never> {
	return op as unknown as Operation<never>;
}

export function operationOf(connector: Connector, name: string): Operation<never> | null {
	return connector.operations.find((op) => op.name === name) ?? null;
}

export function actionOf(connector: Connector, id: string): ActionSpec | null {
	return connector.actions.find((action) => action.id === id) ?? null;
}

export function kindOf(connector: Connector, id: string): ResourceKind | null {
	return connector.kinds.find((kind) => kind.id === id) ?? null;
}

export function nests(connector: Connector, kind: string): boolean {
	return kindOf(connector, kind)?.hierarchical ?? false;
}

/** The action an action requires on the same resource, as the policy asks it. */
export function requiresOf(connector: Connector): (action: string) => string | null {
	return (action) => actionOf(connector, action)?.requires ?? null;
}

/** What an operation means beyond its input and needs, with the defaults filled in. */
export interface OperationTerms {
	outputAction: string;
	consent: Consent | null;
	revision: number;
	mutates: boolean;
	paginated: boolean;
	images: boolean;
}

export function termsOf(op: Operation<never>): OperationTerms {
	return {
		outputAction: op.outputAction ?? "read",
		consent: op.consent ?? null,
		revision: op.revision ?? 1,
		mutates: op.mutates ?? false,
		paginated: op.paginated ?? false,
		images: op.images ?? false,
	};
}

/**
 * Whether the scopes the connection was granted cover the operation: any one set in full. Unknown scopes
 * (null) pass, so the provider is the one to refuse; known but empty ones fail every operation with
 * consent (risk 16).
 */
export function consentGiven(consent: Consent | null | undefined, scopes: readonly string[] | null): boolean {
	if (consent === null || consent === undefined || scopes === null) return true;
	const granted = new Set(scopes);
	return consent.some((option) => option.every((scope) => granted.has(scope)));
}

/** The resource in a tenant: how a connector with a tenant per resource names one. */
export function inTenant(resource: Resource, tenant: string): Resource {
	return { ...resource, tenant };
}

/** One connection as seen by one call: its id and an authenticated provider client. */
export function binding<Client extends ProviderClient>(connectionId: ConnectionId, client: Client): Binding<Client> {
	return {
		connectionId,
		client,
		resource: (kind: string, id: string, within: string[] = [], partial = false): Resource => resource(connectionId, kind, id, within, partial),
		account: (): Resource => resource(connectionId, ACCOUNT_KIND, connectionId),
	};
}
