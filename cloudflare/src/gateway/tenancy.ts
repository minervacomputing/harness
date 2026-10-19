// Connection policies: which connections an organization's policy admits, and the tenants
// a connection with a tenant per resource is limited to. Pure: the compile (tools.ts), the executor and the settings calls
// (internal/connections.ts) decide with it.

import type { ConnectionPolicy } from "@minerva/contract/internal";
import { type Connector, OperationError } from "./connector.ts";
import type { Resource } from "./policy.ts";

export type { ConnectionPolicy };

/**
 * A connection under a policy. Refused: its tools are not offered and its settings calls are refused. Admitted with
 * `tenants`: each resource it touches must be in one of them (a connector with a tenant per resource under a list).
 * Admitted with null: as without a policy.
 */
export type Admission = { admitted: false } | { admitted: true; tenants: readonly string[] | null };

const ADMITTED: Admission = Object.freeze({ admitted: true, tenants: null });
const REFUSED: Admission = Object.freeze({ admitted: false });

/**
 * The admission of a connection of `connector` whose account is in `tenant` (null: none, or never described). No
 * policy admits everything; a connector the policy does not list is refused; a list admits an account in a listed
 * tenant, limits a connector with a tenant per resource to its tenants, and refuses one whose tenancy is unknown.
 */
export function admission(policy: ConnectionPolicy | null | undefined, connector: Connector, tenant: string | null | undefined): Admission {
	if (!policy) return ADMITTED;
	const entry = policy.connectors.find((listed) => listed.provider === connector.slug);
	if (entry === undefined) return REFUSED;
	if (entry.tenants === null) return ADMITTED;
	switch (connector.tenancy.kind) {
		case "account":
			return typeof tenant === "string" && entry.tenants.includes(tenant) ? ADMITTED : REFUSED;
		case "resource":
			return { admitted: true, tenants: [...entry.tenants] };
		case "unknown":
			return REFUSED;
	}
}

/** Whether a resource, or a discovery item, is in one of `tenants`; null allows any, and a list none without a tenant. */
export function inTenants(tenants: readonly string[] | null, resource: Pick<Resource, "tenant">): boolean {
	return tenants === null || (typeof resource.tenant === "string" && tenants.includes(resource.tenant));
}

/** What a connector's tenant is called in a sentence ("this GitHub owner"). */
export function tenantLabel(connector: Connector): string {
	return connector.tenancy.kind === "unknown" ? "organization" : connector.tenancy.label;
}

/** The refusal of a call on a resource of a tenant the policy does not allow, as the model and the user see it. */
export function tenantRefused(connector: Connector): OperationError {
	return new OperationError("POLICY_DENIED", `Your organization does not allow this ${tenantLabel(connector)}.`);
}
