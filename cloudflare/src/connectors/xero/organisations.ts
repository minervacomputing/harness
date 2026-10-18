// What Xero's operations share: organisations, how
// calls name them, and how records show text. How they show money is in decimal.ts.

import { z } from "zod";
import { type Binding, OperationError, type Tenancy, denied, inTenant } from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { truncate } from "../../lib/text.ts";
import { UUID, type Connection, type XeroClient, uuid } from "./client.ts";

export const ORGANISATION = "organisation";
export const MAX_SHORT = 500;

export const NOT_AN_ID = "must be an id from Xero, such as 4f2a3c1e-0b6d-4e8a-9c1f-2a7b5d3e6f80";
const ORGANISATION_NOTE = "An organisation's id, from list_organisations. Optional when the connection reaches one.";
const CONTACT_NOTE = "A contact's id, from search_contacts.";
const INVOICE_NOTE = "An invoice's or bill's id, from search_invoices.";

function isId(value: string): boolean {
	return UUID.test(value.toLowerCase());
}

/** A required id: checked, then kept in lower case. */
function requiredId(description: string) {
	return z.string().trim().min(36).max(36)
		.describe(description)
		.refine(isId, NOT_AN_ID)
		.transform((value) => value.toLowerCase());
}

/**
 * An optional id, null by default. Defaulted before the transform, so the JSON Schema still shows the default:
 * zod leaves out the default of a field whose transform comes first.
 */
function optionalId(description: string) {
	return z.string().trim().min(36).max(36)
		.describe(description)
		.nullable()
		.default(null)
		.refine((value) => value === null || isId(value), NOT_AN_ID)
		.transform((value) => (value === null ? null : value.toLowerCase()));
}

export const organisationId = () => optionalId(ORGANISATION_NOTE);
export const contactId = () => requiredId(CONTACT_NOTE);
export const optionalContactId = () => optionalId(CONTACT_NOTE);
export const invoiceId = () => requiredId(INVOICE_NOTE);

/** A text as records show it: whitespace collapsed, cut to `limit` characters, and null when empty. */
export function short(value: string | null | undefined, limit = MAX_SHORT): string | null {
	const [shown] = truncate(value ? value.trim().replace(/\s+/g, " ") : null, limit);
	return shown || null;
}

export function label(organisation: Connection): string {
	return short(organisation.tenantName) || `Organisation ${organisation.tenantId.slice(0, 8)}`;
}

export function client(binding: Binding): XeroClient {
	return binding.client as XeroClient;
}

/** Each organisation is its own tenant, keyed by its tenant id, which is its id. */
export const TENANCY: Tenancy = {
	kind: "resource",
	label: "Xero organisation",
	async tenants(_client, _kind, ids) {
		const found: { [id: string]: string } = {};
		for (const id of ids) if (uuid(id) === id) found[id] = id;
		return found;
	},
};

export function organisationResource(binding: Binding, tenant: string): Resource {
	if (uuid(tenant) !== tenant) throw client(binding).unexpected();
	return inTenant(binding.resource(ORGANISATION, tenant), tenant);
}

/**
 * The organisation a call names, or the only one the connection reaches. One it does not reach is refused
 * like one without a grant. Nothing is read from an organisation before the executor authorizes it.
 */
export async function resolveOrganisation(binding: Binding, tenant: string | null): Promise<[Resource, string]> {
	const organisations = await client(binding).organisations();
	let chosen: string;
	if (tenant === null) {
		const only = organisations[0];
		if (organisations.length !== 1 || only === undefined) {
			throw new OperationError("INVALID_ARGUMENTS", `This connection reaches ${organisations.length} Xero organisations; name one with organisation.`);
		}
		chosen = only.tenantId;
	} else if (!organisations.some((organisation) => organisation.tenantId === tenant)) {
		throw denied();
	} else {
		chosen = tenant;
	}
	return [organisationResource(binding, chosen), chosen];
}
