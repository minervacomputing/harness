// A connector as the catalog Laravel reads shows it (src/internal/catalog.ts): what Laravel asks a provider for, and
// what the executor's consent check (`consentGiven`) makes of the scopes a provider granted.

import type { CatalogConnector } from "@minerva/contract/internal";
import { type Connector, consentGiven } from "../../src/gateway/connector.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { catalogOf } from "../../src/internal/catalog.ts";

export async function catalogEntry(connector: Connector): Promise<CatalogConnector> {
	const [entry] = (await catalogOf(await Registry.create([connector]))).connectors;
	if (entry === undefined) throw new Error(`${connector.slug} is not in its catalog.`);
	return entry;
}

/** Each operation's first consent option, the scopes Laravel asks for to make it usable; operations without consent are left out. */
export function askedScopes(entry: CatalogConnector): { [operation: string]: string[] } {
	return Object.fromEntries(entry.operations.flatMap((op) => (op.consent?.[0] ? [[op.name, op.consent[0]]] : [])));
}

/** The operations whose consent `scopes` do not meet, in the catalog's order. */
export function uncovered(entry: CatalogConnector, scopes: readonly string[] | null): string[] {
	return entry.operations.filter((op) => !consentGiven(op.consent, scopes)).map((op) => op.name);
}
