// What the Google connectors' tests share, as backend/tests/conftest.py's `connector_run` and
// tests/connector_runs.py's `ceiling` and `refusal` give it: a run of one connection with the user's grants,
// a ceiling row, and the provider's requests through an injected `fetch`.

import type { ConnectionId } from "../../../../src/contracts/common.ts";
import type { Connector, Operation } from "../../../../src/contracts/connectors.ts";
import type { GrantRow } from "../../../../src/contracts/policy.ts";
import { ACCOUNT_KIND } from "../../../../src/gateway/connector.ts";
import { settingsIo } from "../../../../src/gateway/http.ts";
import { validateInput } from "../../../../src/gateway/validation.ts";
import type { Json } from "../../../../src/lib/json.ts";
import { Scenario, USER } from "../../../unit/executor-fakes.ts";
import type { InputCase } from "./vectors.ts";

export const CONNECTION = "0199a000-0000-7000-8000-0000000000e1";

/** One grant per (kind, id), as `{"kind:id": actions}`; an account grant names the connection, whatever its id. */
export function grantRows(connectionId: ConnectionId, grants: { [key: string]: string[] }): GrantRow[] {
	return Object.entries(grants).map(([key, actions]) => {
		const at = key.indexOf(":");
		const kind = key.slice(0, at);
		const resourceId = kind === ACCOUNT_KIND ? connectionId : key.slice(at + 1);
		return { layer: "user", subject: USER, connectionId, kind, resourceId, resourceName: "", actions: [...actions].sort(), effect: "allow" };
	});
}

/** connector_runs.py `ceiling`: a row of the workspace ceiling. */
export function ceilingRow(connectionId: ConnectionId, kind: string, resourceId: string, effect: "allow" | "deny", actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId, kind, resourceId, resourceName: "", actions: [...actions].sort(), effect };
}

export interface StartOptions {
	scopes: string[] | null;
	grants: { [key: string]: string[] };
	ceiling?: GrantRow[];
	ceilingRestricted?: boolean;
}

/** conftest.py `connector_run`: the user's one connection, an OAuth token with `scopes`, and `grants`. */
export function startRun(connector: Connector, fetch: typeof globalThis.fetch, options: StartOptions): Promise<Scenario> {
	return Scenario.start({
		connectors: [connector],
		connections: [{ id: CONNECTION, provider: connector.slug, payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: options.scopes } }],
		user: grantRows(CONNECTION, options.grants),
		ceiling: options.ceiling ?? [],
		ceilingRestricted: options.ceilingRestricted ?? false,
		fetch,
	});
}

/** A connector's client outside a run, as the settings page and `account()` use it. */
export function settingsClient<Client>(connector: Connector<Client & { close(): Promise<void> }>, fetch: typeof globalThis.fetch, token = "token"): Client {
	return connector.client(token, settingsIo(fetch));
}

export function operation(connector: Connector, name: string): Operation<never> {
	const op = connector.operations.find((item) => item.name === name);
	if (op === undefined) throw new Error(`No operation ${name}`);
	return op;
}

/** Each case's outcome under the executor's strict validation (normalized arguments, or refused), next to the expected one. */
export async function validationOutcomes(op: Operation<never>, cases: { [key: string]: InputCase }): Promise<{ actual: unknown[]; expected: unknown[] }> {
	const actual: unknown[] = [];
	const expected: unknown[] = [];
	for (const [key, item] of Object.entries(cases)) {
		expected.push({ key, ...(item.ok ? { ok: item.ok } : item.error ? { refused: true } : { raises: true }) });
		try {
			const result = await validateInput(op.input as never, item.input as Json);
			actual.push({ key, ...(result.ok ? { ok: result.data } : { refused: true }) });
		} catch {
			actual.push({ key, raises: true });
		}
	}
	return { actual, expected };
}

export function jsonResponse(status: number, body: unknown, headers: { [name: string]: string } = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** The request an injected `fetch` was given. */
export function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
	return new Request(input as RequestInfo, init);
}
