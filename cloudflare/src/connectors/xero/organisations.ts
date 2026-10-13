// What Xero's operations share: organisations, how
// calls name them, and how records show text. How they show money is in decimal.ts.

import { z } from "zod";
import type { Binding } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import { pythonCollapse, truncate } from "../../lib/text.ts";
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

/** organisations.py's `_uuid` on a required id: checked, then kept in lower case. */
function requiredId(description: string) {
	return z.string().trim().min(36).max(36)
		.describe(description)
		.refine(isId, NOT_AN_ID)
		.transform((value) => value.toLowerCase());
}

/**
 * The same, `| None = None`. Defaulted before the transform, so the JSON Schema still shows the default: zod
 * leaves out the default of a field whose transform comes first.
 */
function optionalId(description: string) {
	return z.string().trim().min(36).max(36)
		.describe(description)
		.nullable()
		.default(null)
		.refine((value) => value === null || isId(value), NOT_AN_ID)
		.transform((value) => (value === null ? null : value.toLowerCase()));
}

/** `OrganisationId | None = None`. */
export const organisationId = () => optionalId(ORGANISATION_NOTE);
/** `ContactId`. */
export const contactId = () => requiredId(CONTACT_NOTE);
/** `ContactId | None = None`. */
export const optionalContactId = () => optionalId(CONTACT_NOTE);
/** `InvoiceId`. */
export const invoiceId = () => requiredId(INVOICE_NOTE);

/** A text as records show it: whitespace collapsed, cut to `limit` characters, and null when empty. */
export function short(value: string | null | undefined, limit = MAX_SHORT): string | null {
	const [shown] = truncate(value ? pythonCollapse(value) : null, limit);
	return shown || null;
}

export function label(organisation: Connection): string {
	return short(organisation.tenantName) || `Organisation ${organisation.tenantId.slice(0, 8)}`;
}

export function client(binding: Binding): XeroClient {
	return binding.client as XeroClient;
}

export function organisationResource(binding: Binding, tenant: string): Resource {
	if (uuid(tenant) !== tenant) throw client(binding).unexpected();
	return binding.resource(ORGANISATION, tenant);
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
