// Xero. Resources are organisations; agents read contacts,
// invoices, bills, accounts and tax rates, and create draft sales invoices and draft bills.
//
// A connection is one Xero user, and reaches the organisations they picked when connecting (Xero's
// `/connections`); to add one, they connect again. The kind is flat and keyed by the organisation's tenant
// id. An organisation the connection does not reach is refused like one without a grant, and nothing is read
// from an organisation before the executor authorizes the call on it. Calls take an optional `organisation`;
// a connection that reaches several must name one. Everything inside an organisation (contacts, invoices, the
// chart of accounts) is covered by the grant on it.
//
// Drafts are the only writes: see writes.ts. Agents cannot approve, send, pay, void or change invoices.
//
// Xero's scopes are granular. Reading needs `accounting.invoices.read`, `accounting.contacts.read` and
// `accounting.settings.read`; drafting asks for `accounting.invoices` once the user allows it. The user's
// role in each organisation still applies: Xero refuses what it does not allow. Access tokens last 30
// minutes; refresh tokens rotate. The client authenticates to the token endpoint with HTTP Basic, and the
// flow uses PKCE.
//
// This module assembles the connector. The operations are in reads.ts and writes.ts; what they share is in
// organisations.ts and decimal.ts, and Xero's API in client.ts.

import { type Account, type Connector, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { XeroClient } from "./client.ts";
import { ORGANISATION, label } from "./organisations.ts";
import { GET_INVOICE, LIST_ACCOUNTS, LIST_ORGANISATIONS, LIST_TAX_RATES, SEARCH_CONTACTS, SEARCH_INVOICES } from "./reads.ts";
import { CREATE_DRAFT_BILL, CREATE_DRAFT_INVOICE } from "./writes.ts";

export const ORGANISATION_NOTE =
	"The organisations you picked when connecting Xero; to add one, connect again and pick it. Access to all organisations covers ones added later. Drafts are never sent or approved: a person approves them in Xero.";

export const SCOPES = ["openid", "profile", "email", "offline_access", "accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read"];

export function xeroConnector(): Connector<XeroClient> {
	return {
		slug: "xero",
		name: "Xero",
		kinds: [{ id: ORGANISATION, label: "Organisation", actions: ["read", "draft_sales", "draft_bills"], wildcard: true, note: ORGANISATION_NOTE }],
		actions: [
			{ id: "read", label: "Read invoices, bills and contacts" },
			{ id: "draft_sales", label: "Create draft sales invoices", requires: "read" },
			{ id: "draft_bills", label: "Create draft bills", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: "xero",
			authorizeUrl: "https://login.xero.com/identity/connect/authorize",
			tokenUrl: "https://identity.xero.com/connect/token",
			scopes: [...SCOPES],
			scopeSeparator: " ",
			registrationUrl: null,
			authorizeParams: [],
			loginHint: false,
			clientAuth: "basic",
			jsonBody: false,
			pkce: true,
		},
		operations: [LIST_ORGANISATIONS, SEARCH_CONTACTS, SEARCH_INVOICES, GET_INVOICE, LIST_ACCOUNTS, LIST_TAX_RATES, CREATE_DRAFT_INVOICE, CREATE_DRAFT_BILL],
		client: (secret, io) => new XeroClient(secret, io),
		async account(client): Promise<Account> {
			const me = await client.me();
			if (!me.sub) throw client.unexpected();
			if ((await client.organisations()).length === 0) throw new OperationError("UNSUPPORTED_ACCOUNT", "This Xero user connected no organisation to Minerva.");
			const name = me.name || [me.given_name, me.family_name].filter((part) => part).join(" ") || null;
			const person = name && me.email ? `${name} (${me.email})` : name || me.email || "Xero";
			return { id: me.sub, label: person };
		},
		async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
			if (cursor !== null) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
			const folded = query ? query.toLowerCase() : null;
			const items = (await client.organisations()).map((organisation) => ({ id: organisation.tenantId, name: label(organisation) }));
			return { items: items.filter((item) => folded === null || item.name.toLowerCase().includes(folded)) };
		},
		async describe(client, _kind, ids): Promise<{ [id: string]: string }> {
			const wanted = new Set(ids);
			const names: { [id: string]: string } = {};
			for (const organisation of await client.organisations()) {
				if (wanted.has(organisation.tenantId)) names[organisation.tenantId] = label(organisation);
			}
			return names;
		},
	};
}
