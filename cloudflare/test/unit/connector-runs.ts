// What OAuth connector tests share: a run of one connection with the user's grants and ceiling rows, a
// connector's client outside a run, and the arguments an operation accepts.

import { ACCOUNT_KIND, type Connector, type Operation } from "../../src/gateway/connector.ts";
import type { GrantRow } from "../../src/gateway/grants.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import type { ConnectionId } from "../../src/shared/rpc.ts";
import { Scenario, USER } from "./executor-fakes.ts";

export const CONNECTION = "0199a000-0000-7000-8000-0000000000e1";

/** User grants as `{"kind:id": actions}`; an account grant names the connection, whatever its id. */
export function grantRows(grants: { [key: string]: string[] }, connectionId: ConnectionId = CONNECTION): GrantRow[] {
	return Object.entries(grants).map(([key, actions]) => {
		const at = key.indexOf(":");
		const kind = key.slice(0, at);
		const resourceId = kind === ACCOUNT_KIND ? connectionId : key.slice(at + 1);
		return { layer: "user", subject: USER, connectionId, kind, resourceId, resourceName: "", actions: [...actions].sort(), effect: "allow" };
	});
}

/** A row of the workspace ceiling. */
export function ceilingRow(kind: string, resourceId: string, effect: "allow" | "deny", actions: string[] = ["read"]): GrantRow {
	return { layer: "ceiling", subject: null, connectionId: CONNECTION, kind, resourceId, resourceName: "", actions: [...actions].sort(), effect };
}

export interface RunOptions {
	scopes: string[] | null;
	grants: { [key: string]: string[] };
	ceiling?: GrantRow[];
	ceilingRestricted?: boolean;
}

/** A run with the user's one connection: an OAuth token with `scopes`, and `grants`. */
export function startRun(connector: Connector, fetch: typeof globalThis.fetch, options: RunOptions): Promise<Scenario> {
	return Scenario.start({
		connectors: [connector],
		connections: [{ id: CONNECTION, provider: connector.slug, payload: { kind: "oauth2", access_token: "token", refresh_token: null, scopes: options.scopes } }],
		user: grantRows(options.grants),
		ceiling: options.ceiling ?? [],
		ceilingRestricted: options.ceilingRestricted ?? false,
		fetch,
	});
}

/** A connector's client outside a run, as the settings page and `account()` use it. */
export function settingsClient<Client>(connector: Connector<Client & { close(): Promise<void> }>, fetch: typeof globalThis.fetch): Client {
	return connector.client("token", settingsIo(fetch));
}

export function operation(connector: Connector, name: string): Operation<never> {
	const op = connector.operations.find((item) => item.name === name);
	if (op === undefined) throw new Error(`No operation ${name}`);
	return op;
}

/** The arguments as the executor passes them on, or its message when it refuses them. */
export async function validated(connector: Connector, name: string, input: Json): Promise<{ ok: unknown } | { refused: string }> {
	const result = await validateInput(operation(connector, name).input as never, input);
	return result.ok ? { ok: result.data } : { refused: result.message };
}

/** The request an injected `fetch` was given. */
export function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
	return new Request(input as RequestInfo, init);
}
