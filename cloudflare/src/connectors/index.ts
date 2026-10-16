// The connectors this Worker serves, in one registry per isolate that the internal API (the catalog, connection checks,
// grant edits, run snapshots and their fingerprints) and the Conversation's executor (declarations and calls) share, so
// both read the same contracts. A test build (src/faults/)
// and the platform tests add fake connectors through `CONNECTOR_SOURCE` before any object reads it.
//
// The connectors themselves (catalog.ts) are imported on first use, in a chunk of their own: evaluating their
// modules and schemas at the Worker's startup would count against its startup CPU limit (cloudflare/README.md,
// Startup).

import type { Connector } from "../gateway/connector.ts";
import { Registry } from "../gateway/registry.ts";

/** Every connector this Worker serves (catalog.ts), loaded on first use. */
export async function servedConnectors(): Promise<readonly Connector[]> {
	return (await import("./catalog.ts")).CONNECTORS;
}

type Source = () => readonly Connector[] | Promise<readonly Connector[]>;

/** Where the registry's connectors come from; replaced only by a test build and by tests. */
export const CONNECTOR_SOURCE: { connectors: Source } = { connectors: servedConnectors };

let built: { source: Source; registry: Promise<Registry> } | null = null;

/** Built once per isolate (fingerprints are hashed when it is created), again only if the source changed or the build failed. */
export function connectorRegistry(): Promise<Registry> {
	const source = CONNECTOR_SOURCE.connectors;
	if (built === null || built.source !== source) {
		const registry = Promise.resolve().then(source).then((connectors) => Registry.create(connectors));
		const entry = { source, registry };
		built = entry;
		// A failed build is not kept, so the next caller builds again (a module that failed to load stays failed in this
		// isolate: the import rejects again).
		registry.catch(() => {
			if (built === entry) built = null;
		});
	}
	return built.registry;
}
