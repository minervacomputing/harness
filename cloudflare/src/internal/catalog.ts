// The catalog Laravel reads (docs/plans/contract.md, The catalog): every connector the registry serves, with its OAuth
// descriptor, kinds, actions and operations' terms, and a version that names it. Built from the declarations alone.

import type { Catalog, CatalogAuth, CatalogConnector } from "@minerva/contract/internal";
import { type Auth, type Connector, offered } from "../gateway/connector.ts";
import type { Registry } from "../gateway/registry.ts";
import { hashInput } from "../lib/canonical.ts";
import { sha256Hex } from "../lib/hash.ts";

function authOf(auth: Auth): CatalogAuth {
	switch (auth.type) {
		case "builtin":
			return { type: "builtin" };
		case "api_key":
			return { type: "api_key", label: auth.label, hint: auth.hint ?? null };
		case "oauth2":
			return {
				type: "oauth2",
				client: auth.app,
				authorizeUrl: auth.authorizeUrl,
				tokenUrl: auth.tokenUrl,
				scopes: [...auth.scopes],
				scopeSeparator: auth.scopeSeparator ?? " ",
				authorizeParams: (auth.authorizeParams ?? []).map(([name, value]) => ({ name, value })),
				loginHint: auth.loginHint ?? false,
				clientAuth: auth.clientAuth ?? "post",
				tokenBody: auth.jsonBody ? "json" : "form",
				pkce: auth.pkce ?? true,
				registrationUrl: auth.registrationUrl ?? null,
			};
	}
}

function connectorOf(connector: Connector): CatalogConnector {
	const browsable = new Set(connector.browsable ?? []);
	const manage = connector.manageLink ? connector.manageLink() : null;
	return {
		slug: connector.slug,
		name: connector.name,
		auth: authOf(connector.auth),
		kinds: connector.kinds.map((kind) => ({
			id: kind.id,
			label: kind.label,
			actions: [...kind.actions],
			wildcard: kind.wildcard ?? false,
			hierarchical: kind.hierarchical ?? false,
			note: kind.note ?? null,
			listed: kind.listed ?? true,
			browsable: browsable.has(kind.id),
		})),
		actions: connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null })),
		operations: connector.operations.map((op) => ({
			name: op.name,
			title: op.title,
			needs: op.needs.map(([kind, action]) => ({ kind, action })),
			consent: op.consent ? op.consent.map((scopes) => [...scopes]) : null,
			mutates: op.mutates ?? false,
			offered: offered(connector, op),
		})),
		manage: manage === null ? null : { label: manage[0], url: manage[1] },
	};
}

/** The catalog of the registry's connectors, in its order; its version is 16 hex of SHA-256 over their canonical JSON. */
export async function catalogOf(registry: Registry): Promise<Catalog> {
	const connectors = registry.all().map(connectorOf);
	return { version: (await sha256Hex(hashInput("catalog", connectors))).slice(0, 16), connectors };
}
