// The connectors this Worker serves, in one registry per isolate that the Workspace (ConnectionOut, grants,
// run snapshots and their fingerprints) and the Conversation's executor (declarations and calls) share, so
// both read the same contracts. Step 6 adds the 20 connectors to CONNECTORS. A test build (src/faults/)
// and the platform tests add fake connectors through `CONNECTOR_SOURCE` before any object reads it.

import type { Connector } from "../contracts/connectors.ts";
import { Registry } from "../gateway/registry.ts";

export const CONNECTORS: readonly Connector[] = [];

/** Where the registry's connectors come from; replaced only by a test build and by tests. */
export const CONNECTOR_SOURCE: { connectors: () => readonly Connector[] } = { connectors: () => CONNECTORS };

let built: { source: () => readonly Connector[]; registry: Promise<Registry> } | null = null;

/** Built once per isolate (fingerprints are hashed when it is created), again only if the source changed. */
export function connectorRegistry(): Promise<Registry> {
	const source = CONNECTOR_SOURCE.connectors;
	if (built === null || built.source !== source) built = { source, registry: Registry.create(source()) };
	return built.registry;
}
