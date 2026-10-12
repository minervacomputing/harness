// What the Microsoft connectors' tests share, as backend/tests/conftest.py's `connector_run` and
// tests/connector_runs.py's `ceiling` and `refusal` give it: a run of one connection with the user's grants
// and the workspace ceiling's rows, an in-memory Graph behind an injected `fetch`, and the vectors today's
// Python wrote (generate.py beside each vectors.json).

import type { ConnectionId } from "../../../../src/contracts/common.ts";
import type { Connector, Operation } from "../../../../src/contracts/connectors.ts";
import type { GrantRow } from "../../../../src/contracts/policy.ts";
import { settingsIo } from "../../../../src/gateway/http.ts";
import { inputSchema } from "../../../../src/gateway/registry.ts";
import { type Json, parseJson } from "../../../../src/lib/json.ts";
import { Scenario, USER } from "../../../unit/executor-fakes.ts";
import { readVectors } from "../read-vectors.ts";

export const CONNECTION = "0199a000-0000-7000-8000-0000000000d1";

// biome-ignore lint/suspicious/noExplicitAny: the vectors' shape is each test's to read.
export type Vectors = any;

const cache = new Map<string, Vectors>();

/** test/fixtures/connectors/<name>/vectors.json (read-vectors.ts). */
export function vectors(name: string): Vectors {
	let found = cache.get(name);
	if (found === undefined) {
		found = readVectors(new URL(`../${name}/vectors.json`, import.meta.url).pathname);
		cache.set(name, found);
	}
	return found;
}

/** User grants as `{"kind:id": actions}` (connector_runs.py builds them per kind and id). */
export function grantRows(grants: { [key: string]: readonly string[] }, connectionId: ConnectionId = CONNECTION): GrantRow[] {
	return Object.entries(grants).map(([key, actions]) => {
		const at = key.indexOf(":");
		return {
			layer: "user",
			subject: USER,
			connectionId,
			kind: key.slice(0, at),
			resourceId: key.slice(at + 1),
			resourceName: "",
			actions: [...actions].sort(),
			effect: "allow",
		};
	});
}

/** connector_runs.py `ceiling`: a row of the workspace ceiling. */
export function ceilingRow(kind: string, resourceId: string, effect: "allow" | "deny", actions: readonly string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: CONNECTION, kind, resourceId, resourceName: "", actions: [...actions].sort(), effect };
}

export interface RunOptions {
	scopes: string[] | null;
	grants: { [key: string]: readonly string[] };
	ceiling?: GrantRow[];
}

/** conftest.py `connector_run`: the user's one connection, an OAuth token with `scopes`, and `grants`. */
export function startRun(connector: Connector, fetch: typeof globalThis.fetch, options: RunOptions): Promise<Scenario> {
	return Scenario.start({
		connectors: [connector],
		connections: [{ id: CONNECTION, provider: connector.slug, payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: options.scopes } }],
		user: grantRows(options.grants),
		ceiling: options.ceiling ?? [],
		fetch,
	});
}

/** A connector's client outside a run, as `account()` and the settings page use it. */
export function settingsClient<Client>(connector: Connector<Client & { close(): Promise<void> }>, fetch: typeof globalThis.fetch): Client {
	return connector.client("token", settingsIo(fetch));
}

export function operation(connector: Connector, name: string): Operation<never> {
	const op = connector.operations.find((item) => item.name === name);
	if (op === undefined) throw new Error(`No operation ${name}`);
	return op;
}

export function jsonResponse(status: number, body: unknown, headers: { [name: string]: string } = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** One request a fake Graph received, read as its handler reads it. */
export interface Received {
	method: string;
	url: URL;
	host: string;
	/** The path with Graph's /v1.0 taken off. */
	path: string;
	/** The path as sent, still percent-encoded. */
	rawPath: string;
	/** The query's parameters, decoded; the last of a repeated one. */
	params: { [name: string]: string };
	headers: Headers;
	body: string;
	bytes: Uint8Array;
}

export async function received(input: RequestInfo | URL, init?: RequestInit): Promise<Received> {
	const request = new Request(input as RequestInfo, init);
	const url = new URL(request.url);
	const bytes = new Uint8Array(await request.arrayBuffer());
	const rawPath = url.pathname;
	return {
		method: request.method,
		url,
		host: url.hostname,
		path: decodeURIComponent(rawPath).replace(/^\/v1\.0/, ""),
		rawPath,
		params: Object.fromEntries(url.searchParams),
		headers: request.headers,
		body: new TextDecoder().decode(bytes),
		bytes,
	};
}

/** Python's `json.dumps(value)` key order and types survive a round trip through parseJson. */
export function json(text: string): { [key: string]: Json } {
	return parseJson(text) as { [key: string]: Json };
}

function descriptions(schema: unknown): string[] {
	const found = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) for (const item of value) walk(item);
		else if (typeof value === "object" && value !== null) {
			const description = (value as { description?: unknown }).description;
			if (typeof description === "string") found.add(description);
			for (const item of Object.values(value)) walk(item);
		}
	};
	walk(schema);
	return [...found].sort();
}

/**
 * A connector's declaration in the shape generate.py's `declaration()` writes it from today's Python: kinds,
 * actions, auth, and every operation's strings and terms, with the descriptions of each input field's JSON
 * Schema (zod's, as the model sees it) and the fields it requires.
 */
export function declarationOf(connector: Connector): Json {
	const auth = connector.auth;
	if (auth.type !== "oauth2") throw new Error("not an OAuth connector");
	return {
		slug: connector.slug,
		name: connector.name,
		kinds: connector.kinds.map((kind) => ({
			id: kind.id,
			label: kind.label,
			actions: kind.actions,
			wildcard: kind.wildcard ?? false,
			hierarchical: kind.hierarchical ?? false,
			note: kind.note ?? null,
			listed: kind.listed ?? true,
		})),
		actions: connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null })),
		auth: {
			app: auth.app,
			authorize_url: auth.authorizeUrl,
			token_url: auth.tokenUrl,
			scopes: auth.scopes,
			scope_separator: auth.scopeSeparator ?? " ",
			registration_url: auth.registrationUrl ?? null,
			authorize_params: auth.authorizeParams ?? [],
			login_hint: auth.loginHint ?? false,
			client_auth: auth.clientAuth ?? "post",
			json_body: auth.jsonBody ?? false,
			pkce: auth.pkce ?? true,
		},
		browsable: [...(connector.browsable ?? [])].sort(),
		manage_link: connector.manageLink?.() ?? null,
		operations: connector.operations.map((op) => {
			const schema = inputSchema(op as Operation<never>) as { properties?: { [name: string]: unknown }; required?: string[] };
			return {
				name: op.name,
				title: op.title,
				description: op.description,
				needs: op.needs,
				output_action: op.outputAction ?? "read",
				consent: op.consent ? op.consent.map((option) => [...option].sort()) : null,
				revision: op.revision ?? 1,
				mutates: op.mutates ?? false,
				paginated: op.paginated ?? false,
				offered: connector.offered?.(op as Operation<never>) ?? true,
				fields: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, field]) => [name, descriptions(field)])),
				required: [...(schema.required ?? [])].sort(),
			};
		}),
	};
}
