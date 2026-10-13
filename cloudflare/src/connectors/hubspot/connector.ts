// HubSpot's CRM: contacts, companies and deals, through a public app installed with OAuth.
//
// The connection is the HubSpot account (portal) the app was installed in. HubSpot's tokens carry the app's
// scopes, not the installing user's HubSpot permissions: an agent reaches every contact, company and deal the
// scopes cover, within what users allow in Minerva. Users choose among all contacts, all companies, all deals
// and the deals of single pipelines (see scope.ts), and actions: read, create, edit and log notes. Companies
// are never created or edited, though notes can be logged on them. HubSpot's own automations (workflows, the
// setting that creates companies from contacts' email domains) may act on what an agent changes, beyond
// Minerva's reach.
//
// The APIs are pinned to a date version (client.ts VERSION). Every scope is requested on connecting, since
// HubSpot refuses an install whose scopes differ from the app's required ones. Token responses list the
// granted scopes as `scopes`, which the generic token parsing reads (workspace/credentials.ts parseScopes).
//
// This module assembles the connector. The operations are in reads.ts and writes.ts; what they share is in
// scope.ts, the HTTP client in client.ts and the response models in models.ts.

import type { Connector, DiscoveryItem } from "../../contracts/connectors.ts";
import { HubSpotClient } from "./client.ts";
import type { Pipeline } from "./models.ts";
import { GET_COMPANY, GET_CONTACT, GET_DEAL, LIST_PIPELINES, SEARCH_COMPANIES, SEARCH_CONTACTS, SEARCH_DEALS } from "./reads.ts";
import { COLLECTIONS, PIPELINE_PREFIX, RECORD } from "./scope.ts";
import { ADD_NOTE, CREATE_CONTACT, CREATE_DEAL, UPDATE_CONTACT, UPDATE_DEAL } from "./writes.ts";

export const SCOPES: readonly string[] = [
	"oauth",
	"crm.objects.contacts.read",
	"crm.objects.contacts.write",
	"crm.objects.companies.read",
	"crm.objects.deals.read",
	"crm.objects.deals.write",
];

function pipelineItem(found: Pipeline): DiscoveryItem {
	return { id: `${PIPELINE_PREFIX}${found.id}`, name: `Deals in ${found.label}` };
}

function collectionItems(): DiscoveryItem[] {
	return [...COLLECTIONS].map(([id, name]) => ({ id, name }));
}

export function hubspotConnector(): Connector<HubSpotClient> {
	return {
		slug: "hubspot",
		name: "HubSpot",
		kinds: [
			{
				id: RECORD,
				label: "CRM records",
				actions: ["read", "create", "edit", "note"],
				wildcard: true,
				hierarchical: true,
				note:
					"Choose all contacts, all companies, all deals, or the deals of one pipeline. Companies are " +
					"never created or edited, but notes can be logged on them. Minerva reaches what the HubSpot app's scopes allow, whatever the HubSpot " +
					"permissions of the person who connected it.",
			},
		],
		actions: [
			{ id: "read", label: "Read" },
			{ id: "create", label: "Create contacts and deals", requires: "read" },
			{ id: "edit", label: "Edit contacts and deals", requires: "read" },
			{ id: "note", label: "Log notes", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: "hubspot",
			authorizeUrl: "https://app.hubspot.com/oauth/authorize",
			tokenUrl: "https://api.hubspot.com/oauth/2026-09/token",
			scopes: [...SCOPES],
			clientAuth: "post",
			pkce: false,
		},
		operations: [
			SEARCH_CONTACTS,
			GET_CONTACT,
			SEARCH_COMPANIES,
			GET_COMPANY,
			LIST_PIPELINES,
			SEARCH_DEALS,
			GET_DEAL,
			CREATE_CONTACT,
			UPDATE_CONTACT,
			CREATE_DEAL,
			UPDATE_DEAL,
			ADD_NOTE,
		],
		client: (accessToken, io) => new HubSpotClient(accessToken, io),
		async account(client) {
			const found = await client.details();
			const portal = found.portalId.toString();
			return { id: portal, label: found.portalName ? `${found.portalName} (${portal})` : `HubSpot ${portal}` };
		},
		async discover(client, _kind, { query }) {
			let items = [...collectionItems(), ...(await client.pipelines()).filter((found) => !found.archived).map(pipelineItem)];
			if (query) {
				const folded = query.toLowerCase();
				items = items.filter((item) => item.name.toLowerCase().includes(folded));
			}
			return { items };
		},
		async describe(client, _kind, ids) {
			const names = new Map(COLLECTIONS);
			if (ids.some((id) => id.startsWith(PIPELINE_PREFIX))) {
				for (const item of (await client.pipelines()).map(pipelineItem)) names.set(item.id, item.name);
			}
			return Object.fromEntries(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id) as string]));
		},
	};
}
