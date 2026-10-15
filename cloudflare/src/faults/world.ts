// A Laravel run's world in the test build: a Notes connection (connector.ts) Laravel holds for the agent, the layers that let
// the run's user read and create in its folders, the credential the fake Laravel (laravel.ts) lends for it, and the run as
// Laravel holds it before its start. Plain values, for the platform tests with the in-memory fake Laravel and for the driver
// with the one each workspace's FaultProvider hosts. No imports but the contract's types, so the account tests' driver can
// build its starts in Node.

import type { GrantInput, StartRun } from "@minerva/contract/internal";

/** The fake connector's slug and its one kind (connector.ts). */
export const NOTES = "notes";
export const FOLDER = "folder";

type Grant = Omit<GrantInput, "connection">;

const ALL_FOLDERS: Grant[] = [{ kind: FOLDER, resource: "*", name: "", actions: ["read", "create"], effect: "allow" }];

/** The Notes connection as a start's authority names it: shared with the workspace, so any user's run may use it. */
export function notesConnection(id: string): StartRun["authority"]["connections"][number] {
	return { id, provider: NOTES, owner: null, status: "active", createdAt: new Date().toISOString(), scopes: ["notes"], revision: 1 };
}

/** The layers of a run on the connection: the user's, restricted to `grants` (every folder, read and create). */
export function notesLayers(connectionId: string, grants: Grant[] = ALL_FOLDERS): StartRun["authority"]["layers"] {
	return { ceiling: null, user: { restricted: true, revision: 1, grants: grants.map((grant) => ({ connection: connectionId, ...grant })) }, agent: null };
}

/** The credential the fake Laravel lends for the connection (a `FakeConnection`): the fake provider's seeded access token, for an hour. */
export function notesLease() {
	return { kind: "oauth2" as const, secret: "notes-access-0", scopes: ["notes"], generation: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: "active" as const };
}

/** The start's run as Laravel holds it before sending the start (a `FakeRun`): active, with the agent's connections authorized. */
export function heldRun(start: StartRun) {
	return { scope: start.scope, conversation: start.conversation, active: true, authorized: start.authority.connections.map((connection) => connection.id) };
}
