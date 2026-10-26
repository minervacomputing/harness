// The catalog Laravel reads: every connector the registry serves, with its OAuth
// descriptor, kinds, actions and operations' terms, and a version that names it, built from the declarations alone; and
// the build's prices (budget/prices.ts), with their own version.

import type { Catalog, CatalogAuth, CatalogConnector } from "@minerva/contract/internal";
import type { Prices } from "../budget/prices.ts";
import type { Auth, Connector } from "../gateway/connector.ts";
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
			// Every operation runs on every engine; v1 keeps the field.
			offered: true,
		})),
		manage: manage === null ? null : { label: manage[0], url: manage[1] },
		tenancy: connector.tenancy.kind === "unknown" ? { kind: "unknown", label: null } : { kind: connector.tenancy.kind, label: connector.tenancy.label },
	};
}

const versions = new WeakMap<Registry, Promise<string>>();

/** The registry's catalog version, computed once per registry. */
export function catalogVersion(registry: Registry): Promise<string> {
	let version = versions.get(registry);
	if (version === undefined) {
		version = catalogOf(registry).then((catalog) => catalog.version);
		versions.set(registry, version);
	}
	return version;
}

/**
 * The catalog of the registry's connectors, in its order, and `prices` when given; its version is 16 hex of SHA-256 over
 * the connectors' canonical JSON alone.
 */
export async function catalogOf(registry: Registry, prices?: Prices): Promise<Catalog> {
	const connectors = registry.all().map(connectorOf);
	return { version: (await sha256Hex(hashInput("catalog", connectors))).slice(0, 16), connectors, ...(prices ? { prices } : {}) };
}
