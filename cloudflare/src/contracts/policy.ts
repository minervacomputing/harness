// The permission model's data (connectors 3, 4). The algebra itself (`permits`, `permitsAny`, with
// partial ancestry) is gateway/policy.ts, and the layers and grant edits are gateway/grants.ts.

import type { ConnectionId } from "./common.ts";

/** Selects every resource of a kind, including later ones. Never a real resource id. */
export type Any = "*";

/** `(connection id, resource kind, resource id, action)`. */
export type GrantKey = [connection: ConnectionId, kind: string, resource: string, action: string];

/** A layer as a run snapshots it: lists sorted, round-trip stable (connectors 3.1). */
export interface LayerSnapshot {
	name: "ceiling" | "user" | "agent" | "deny-all";
	/** An unrestricted layer passes everything its denies do not block. */
	restricted: boolean;
	allows: GrantKey[];
	denies: GrantKey[];
}

/**
 * The effective policy: ceiling ∩ user ∩ agent, deny wins, in that order (`["ceiling", "user", "agent"]`
 * is pinned by a test). Only enforceable rows are kept: denies always, allows only for a declared kind and
 * not `*` unless the kind is wildcard (connectors 4.3).
 */
export type PolicySnapshot = LayerSnapshot[];

/**
 * A resource as a connector names it (connectors 1.1). `within` lists ancestors nearest first, for
 * hierarchical kinds only; `partial` says ancestors beyond them may exist, so any exact deny for the
 * action blocks and unknown ancestors never help an allow. At most 64 ancestors, no `*`, no duplicates.
 */
export interface Resource {
	connectionId: ConnectionId;
	kind: string;
	id: string;
	within: string[];
	partial: boolean;
}

/** A grant row in the Workspace Durable Object (connectors 4.1). */
export interface GrantRow {
	layer: "ceiling" | "user" | "agent";
	/** The user of a user layer, the agent of an agent layer. */
	subject: string | null;
	connectionId: ConnectionId;
	kind: string;
	/** ≤200 characters, or `*`. */
	resourceId: string;
	/** Display only, ≤300 characters. */
	resourceName: string;
	/** Sorted, unique. */
	actions: string[];
	effect: "allow" | "deny";
}

/** One change of `PATCH …/access` (≤100 per request; empty actions remove the grant) (connectors 4.5). */
export interface GrantChange {
	kind: string;
	id: string;
	actions: string[];
}
