// The settings calls Laravel makes with a credential it holds (docs/plans/contract.md, Credentials in settings calls): the
// credential arrives in the command, is used for this call only, and is never stored or logged. A provider's refusal of it
// is `CREDENTIAL_REFUSED`, which Laravel acts on; a resource id or a page token the provider cannot take is
// `INVALID_RESOURCE_ID` or `INVALID_CURSOR`; any other failure is `PROVIDER_FAILED`.

import {
	type CheckGrantEdit,
	type CheckGrantEditResult,
	type DescribeAccount,
	type DescribeAccountResult,
	type GrantInput,
	INTERNAL_REFUSALS,
	type ListResources,
	type ListResourcesResult,
} from "@minerva/contract/internal";
import { ORPCError } from "@orpc/server";
import { connectorRegistry } from "../connectors/index.ts";
import { storable } from "../conversation/events.ts";
import { ACCOUNT_KIND, type Connector, type DiscoveryPage, OperationError, type ProviderClient, kindOf } from "../gateway/connector.ts";
import { unauthorized } from "../gateway/executor.ts";
import { type GrantChange, type GrantRow, InvalidGrants, checkChanges, planGrantChanges, resourceKey } from "../gateway/grants.ts";
import { ANY } from "../gateway/policy.ts";
import { admission, inTenants } from "../gateway/tenancy.ts";
import { compareText } from "../lib/arrays.ts";
import { sliceText } from "../lib/text.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { internalRefusal } from "./errors.ts";
import { providerAccount, withProvider } from "./providers.ts";

/** A grant's name as Laravel stores it (contract `GrantInput.name`), in JSON Postgres takes. */
const NAME_MAX = 300;
/** The grants a layer may hold (contract `LayerInput`), so the answer can be sent back in the next command. */
const LAYER_MAX = 10_000;
/** What a provider answers when browsing into something that is not a folder, or is not there. */
const NOT_BROWSABLE: ReadonlySet<string> = new Set(["UNSUPPORTED_FILE", "NOT_FOUND"]);

type SettingsCall = DescribeAccount;

/** VALIDATION_FAILED at one field, as the contract's input validation answers it. */
function invalidInput(path: string[], message: string): ORPCError<"VALIDATION_FAILED", { issues: { path: string[]; message: string; code: string }[] }> {
	const worded = `${path.join(".")}: ${message}`;
	return new ORPCError("VALIDATION_FAILED", { defined: true, status: INTERNAL_REFUSALS.VALIDATION_FAILED, message: worded, data: { issues: [{ path, message: worded, code: "custom" }] } });
}

/** The connector a settings call names, if its credential is of the connector's kind. */
async function connectorFor(command: SettingsCall): Promise<Connector> {
	const connector = (await connectorRegistry()).find(command.connection.provider);
	if (connector === null) throw internalRefusal("NOT_FOUND", "This engine has no such connector.");
	if (connector.auth.type !== command.credential.kind) throw invalidInput(["credential", "kind"], `${connector.name} takes a credential of the kind ${connector.auth.type}.`);
	return connector;
}

/** The provider refused the credential: a refusal at the call (`unauthorized`), or a key a connector refuses itself (Stripe's). */
function refusedCredential(error: OperationError): boolean {
	return unauthorized(error) || error.code === "INVALID_KEY";
}

/** The workspace a settings call's provider requests are made for. Laravel's conversations, and so its workspaces, are in the EU. */
function workspaceOf(command: SettingsCall): WorkspaceRef {
	return { id: command.scope.workspace, jurisdiction: "eu" };
}

/**
 * The account behind the credential, with its tenant for a connector with a tenant per account, and the tenants it reaches
 * now for any connector whose tenancy is known (docs/plans/chunk-17-design.md).
 */
export async function describeAccount(env: Env, command: DescribeAccount): Promise<DescribeAccountResult> {
	const connector = await connectorFor(command);
	try {
		const account = await providerAccount(env, workspaceOf(command), connector, command.credential.secret);
		const tenants = (account.tenants ?? []).map((tenant) => ({ id: tenant.id, name: grantName(tenant.name) }));
		const kind = connector.tenancy.kind;
		if (kind === "account" && tenants.length > 1) throw new Error(`${connector.slug} named ${tenants.length} tenants for one account`);
		const tenant = kind === "account" ? (tenants[0]?.id ?? null) : null;
		return { outcome: "described", account: { id: account.id, label: account.label, tenant, ...(kind === "unknown" ? {} : { tenants }) } };
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		if (refusedCredential(error)) return { outcome: "refused", code: "CREDENTIAL_REFUSED", message: error.message };
		return { outcome: "refused", code: "PROVIDER_FAILED", message: error.message };
	}
}

/** A connection the organization's policy does not admit (gateway/tenancy.ts); Laravel words it for people. */
const NOT_ALLOWED = { outcome: "refused", code: "CONNECTION_NOT_ALLOWED", message: "Your organization does not allow this connection." } as const;

/** A provider's failure as a settings call's refusal; `browsing` when it listed inside a parent the caller named. */
function refusalOf(error: OperationError, browsing = false): { outcome: "refused"; code: string; message: string } {
	if (refusedCredential(error)) return { outcome: "refused", code: "CREDENTIAL_REFUSED", message: error.message };
	if (error.code === "INVALID_ARGUMENTS" || (browsing && NOT_BROWSABLE.has(error.code))) return { outcome: "refused", code: "INVALID_RESOURCE_ID", message: error.message };
	if (error.code === "INVALID_CURSOR") return { outcome: "refused", code: "INVALID_CURSOR", message: error.message };
	return { outcome: "refused", code: "PROVIDER_FAILED", message: error.message };
}

/** Runs `run` with a client holding the command's credential, for this call only. */
function withCredential<T>(env: Env, command: SettingsCall, connector: Connector, run: (client: ProviderClient) => Promise<T>): Promise<T> {
	return withProvider(env, workspaceOf(command), connector, command.credential.secret, run);
}

/** A name from the provider as a grant keeps it. */
function grantName(name: string): string {
	return sliceText(storable(name), 0, NAME_MAX);
}

/**
 * A page of the account's resources of a kind (api/connections.ts `resources`, without the caller's grants, which Laravel
 * holds): the account kind is the connection itself; a browsable kind without a query is listed level by level. Under a
 * connection policy, a connection it does not admit is refused, and items of tenants it does not allow are left out.
 */
export async function listResources(env: Env, command: ListResources): Promise<ListResourcesResult> {
	const connector = await connectorFor(command);
	if (kindOf(connector, command.kind) === null) throw invalidInput(["kind"], `${connector.name} has no resources of type ${JSON.stringify(command.kind)}.`);
	const browse = (connector.browsable ?? []).includes(command.kind) && !command.query;
	if (command.parent !== null && !browse) throw invalidInput(["parent"], "Only resources that nest can be browsed, and not while searching.");
	const admitted = admission(command.policy, connector, command.connection.tenant);
	if (!admitted.admitted) return NOT_ALLOWED;
	const allowed = admitted.tenants;
	try {
		const page = await withCredential(env, command, connector, async (client): Promise<DiscoveryPage> => {
			if (command.kind === ACCOUNT_KIND) {
				const account = await connector.account(client);
				return { items: [{ id: command.connection.id, name: account.label }], nextCursor: null };
			}
			if (!browse) return connector.discover(client, command.kind, { query: command.query || null, cursor: command.cursor });
			if (!connector.children) throw new Error(`${connector.slug} browses ${command.kind} without children()`);
			return connector.children(client, command.kind, command.parent, { cursor: command.cursor });
		});
		const items = page.items
			.filter((item) => item.id !== ANY && inTenants(allowed, item))
			.map((item) => ({ id: item.id, name: item.name, expandable: browse && (item.expandable ?? false) }));
		return { outcome: "listed", items, next: page.nextCursor ?? null };
	} catch (error) {
		if (error instanceof OperationError) return refusalOf(error, browse && command.parent !== null);
		throw error;
	}
}

/** The names of what the changes newly allow, from the provider; undefined when the account cannot see one. */
async function newNames(
	env: Env,
	command: CheckGrantEdit,
	connector: Connector,
	changes: readonly GrantChange[],
	stored: ReadonlyMap<string, string>,
): Promise<{ names: Map<string, string> } | { unseen: string }> {
	const names = new Map<string, string>();
	const wanted = new Map<string, string[]>();
	let account = false;
	for (const change of changes) {
		if (change.actions.length === 0) continue;
		const key = resourceKey(change.kind, change.id);
		// A grant on every resource has no name: the editor names it by its kind.
		if (change.id === ANY || stored.has(key)) continue;
		if (change.kind === ACCOUNT_KIND) {
			account = true;
		} else {
			wanted.set(change.kind, [...(wanted.get(change.kind) ?? []), change.id]);
		}
	}
	if (!account && wanted.size === 0) return { names };
	return withCredential(env, command, connector, async (client) => {
		if (account) names.set(resourceKey(ACCOUNT_KIND, command.connection.id), grantName((await connector.account(client)).label));
		for (const [kind, ids] of wanted) {
			const found = await connector.describe(client, kind, ids);
			for (const id of ids) {
				const name = Object.hasOwn(found, id) ? found[id] : undefined;
				if (typeof name !== "string") return { unseen: (kindOf(connector, kind)?.label ?? kind).toLowerCase() };
				names.set(resourceKey(kind, id), grantName(name));
			}
		}
		return { names };
	});
}

/**
 * The answer to the first resource the changes allow (not `*`, not the account) whose tenant is not one of `tenants`,
 * asking the provider through the connector's tenancy: `invalid` when the connector cannot place it, `TENANT_NOT_ALLOWED`,
 * which Laravel words for people, when the policy does not allow it; null when there is none. A grant already stored is
 * checked too: an edit that keeps it allows it again.
 */
async function outsideTenants(
	env: Env,
	command: CheckGrantEdit,
	connector: Connector,
	changes: readonly GrantChange[],
	tenants: readonly string[],
	nameOf: (kind: string, id: string) => string,
): Promise<CheckGrantEditResult | null> {
	const tenancy = connector.tenancy;
	if (tenancy.kind !== "resource") return null;
	const wanted = new Map<string, string[]>();
	for (const change of changes) {
		if (change.actions.length === 0 || change.id === ANY || change.kind === ACCOUNT_KIND) continue;
		wanted.set(change.kind, [...(wanted.get(change.kind) ?? []), change.id]);
	}
	if (wanted.size === 0) return null;
	return withCredential(env, command, connector, async (client) => {
		for (const [kind, ids] of wanted) {
			const found = await tenancy.tenants(client, kind, ids);
			for (const id of ids) {
				const tenant = Object.hasOwn(found, id) ? found[id] : undefined;
				if (typeof tenant !== "string") return { outcome: "invalid", message: `Choose a ${(kindOf(connector, kind)?.label ?? kind).toLowerCase()} that the connected account can see.` };
				if (!tenants.includes(tenant)) return { outcome: "refused", code: "TENANT_NOT_ALLOWED", message: `Your organization does not allow the ${tenancy.label} of ${nameOf(kind, id)}.` };
			}
		}
		return null;
	});
}

/**
 * Checks an edit of a layer's allow grants on one connection, without storing anything (Laravel stores the answer), and
 * answers the layer's grants after it: every other grant kept in place and order, this connection's allow grants after
 * them, sorted. Resources and accounts newly allowed are named by the provider, so only what the account can see is
 * allowed; `*`, what is already allowed, and removals never call it. Under a connection policy, an edit that allows
 * anything on a connection it does not admit is refused (`CONNECTION_NOT_ALLOWED`), as is one allowing a resource of a
 * tenant it does not allow (`TENANT_NOT_ALLOWED`); removals are always valid.
 */
export async function checkGrantEdit(env: Env, command: CheckGrantEdit): Promise<CheckGrantEditResult> {
	const connector = await connectorFor(command);
	const connectionId = command.connection.id;
	const changes: GrantChange[] = command.changes.map((change) => ({ kind: change.kind, id: change.id, actions: change.actions }));
	const admitted = admission(command.policy, connector, command.connection.tenant);
	const isEdited = (grant: GrantInput) => grant.connection === connectionId && grant.effect === "allow";
	// The policy unions the actions of grants on one resource, so a layer holding two keeps both in one.
	const merged = new Map<string, GrantRow>();
	for (const grant of command.layer.grants.filter(isEdited)) {
		const key = resourceKey(grant.kind, grant.resource);
		const found = merged.get(key);
		merged.set(key, {
			layer: command.layer.level,
			subject: command.layer.subject,
			connectionId,
			kind: grant.kind,
			resourceId: grant.resource,
			resourceName: found?.resourceName || grant.name,
			actions: [...new Set([...(found?.actions ?? []), ...grant.actions])].sort(),
			effect: "allow",
		});
	}
	const current = [...merged.values()];
	const stored = new Map(current.map((grant) => [resourceKey(grant.kind, grant.resourceId), grant.resourceName]));
	try {
		checkChanges(connector, connectionId, changes);
		if (!admitted.admitted && changes.some((change) => change.actions.length > 0)) return NOT_ALLOWED;
		const named = await newNames(env, command, connector, changes, stored);
		if ("unseen" in named) return { outcome: "invalid", message: `Choose a ${named.unseen} that the connected account can see.` };
		if (admitted.admitted && admitted.tenants !== null) {
			const nameOf = (kind: string, id: string) => named.names.get(resourceKey(kind, id)) || stored.get(resourceKey(kind, id)) || id;
			const outside = await outsideTenants(env, command, connector, changes, admitted.tenants, nameOf);
			if (outside !== null) return outside;
		}
		const plan = planGrantChanges(connector, current, changes, named.names);
		const upserted = new Map(plan.upserts.map((row) => [resourceKey(row.kind, row.resourceId), row.resourceName]));
		const edited: GrantInput[] = [...plan.state.entries()]
			.map(([key, entry]) => ({
				connection: connectionId,
				kind: entry.kind,
				resource: entry.id,
				name: upserted.get(key) ?? stored.get(key) ?? "",
				actions: [...entry.actions].sort(),
				effect: "allow" as const,
			}))
			.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.resource, b.resource));
		const grants = [...command.layer.grants.filter((grant) => !isEdited(grant)), ...edited];
		if (grants.length > LAYER_MAX) return { outcome: "invalid", message: `A layer can have at most ${LAYER_MAX.toLocaleString("en")} permissions.` };
		return { outcome: "valid", grants };
	} catch (error) {
		if (error instanceof InvalidGrants) return { outcome: "invalid", message: error.message };
		if (error instanceof OperationError) return refusalOf(error);
		throw error;
	}
}
