// What a Laravel conversation's object answers where a Workspace conversation's asks its Workspace object
// (docs/plans/start-and-cancel.md, Two kinds of conversation). Laravel registers its runs itself and reaches the object
// directly with `startRun` and `cancelRun`, so there is no registration to ask about: a stored run is active until a
// cancel ends it. Laravel learns of an end and of usage from the run's facts, and lends credentials with `leaseToken`,
// both chunk 7 of product-and-engine.md; until then a connector tool's lease is refused.

import type { WorkspaceClient } from "./ports.ts";

/** The lease's refusal until chunk 7 asks Laravel. */
export const NO_LEASE = "This connection is not available to the agent yet.";

export const laravelRuns: WorkspaceClient = {
	beginRun: () => Promise.reject(new Error("Laravel's runs are started by startRun, never by beginRun.")),
	activate: async () => ({ state: "active" }),
	release: async () => {},
	conversationTouched: async () => {},
	lease: async () => ({ refused: "PROVIDER_UNAVAILABLE", message: NO_LEASE }),
	markUnauthorized: async () => {},
};
