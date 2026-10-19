// Connection policies in Laravel's runs: the policy a start carries decides which of its
// connections the run is offered, and the tenants it limits a connection to are checked on the run's calls. The fake
// Laravel the test build hosts lends the credential, and an in-memory GitHub answers the run's requests.

import { env } from "cloudflare:workers";
import type { ConnectionPolicy, Fact, StartRun } from "@minerva/contract/internal";
import { afterAll, beforeAll, expect, test } from "vitest";
import { defaultPorts, PORTS } from "../../src/conversation/ports.ts";
import type { LaravelView } from "../../src/faults/laravel.ts";
import { faultConversationPorts, providerOf } from "../../src/faults/ports.ts";
import { heldRun, notesConnection, notesLayers } from "../../src/faults/world.ts";
import { uuid7 } from "../../src/lib/random.ts";
import type { FakeScript } from "../../src/model/fake.ts";
import { commands, scope, signedAssertions, startOf } from "./internal-support.ts";

signedAssertions();

/** acme (100) owns acme/app; ada (42) owns ada/notes. */
const REPOSITORIES = [
	{ id: 1, full_name: "acme/app", owner: { id: 100, login: "acme" }, private: false, default_branch: "main" },
	{ id: 3, full_name: "ada/notes", owner: { id: 42, login: "ada" }, private: false, default_branch: "main" },
];

/** What the in-memory GitHub was asked. */
const asked: string[] = [];

function github(request: Request): Response {
	const path = new URL(request.url).pathname;
	asked.push(path);
	const byName = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
	const byId = path.match(/^\/repositories\/(\d+)$/);
	const found = REPOSITORIES.find((repository) => repository.full_name === byName?.[1] || String(repository.id) === byId?.[1]);
	return found ? Response.json(found) : Response.json({ message: "Not Found" }, { status: 404 });
}

beforeAll(() => {
	PORTS.factory = () => {
		const ports = faultConversationPorts(defaultPorts);
		return {
			...ports,
			fetch: (context) => {
				const outside = ports.fetch(context);
				return async (input, init) => {
					const request = new Request(input as RequestInfo, init as RequestInit);
					return new URL(request.url).host === "api.github.com" ? github(request) : outside(input, init);
				};
			},
		};
	};
});

afterAll(() => {
	asked.length = 0;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake Laravel's view of the conversation once it holds the run's last fact. */
async function settled(start: StartRun): Promise<LaravelView> {
	const started = Date.now();
	for (;;) {
		const state = await providerOf(env, start.scope.workspace).laravelState(start.conversation);
		if (state.facts.some((fact) => fact.type === "run.settled" && fact.run === start.run)) return state;
		if (Date.now() - started > 15_000) throw new Error(`Timed out waiting; last: ${JSON.stringify(state.facts.map((fact) => fact.type))}`);
		await sleep(50);
	}
}

function githubConnection(id: string, tenant: string | null = null): StartRun["authority"]["connections"][number] {
	return { id, provider: "github", owner: "42", status: "active", createdAt: new Date().toISOString(), scopes: [], revision: 1, tenant };
}

function calendarConnection(id: string, tenant: string | null, createdAt: string): StartRun["authority"]["connections"][number] {
	return { id, provider: "google_calendar", owner: "42", status: "active", createdAt, scopes: null, revision: 1, tenant };
}

function policyOf(...connectors: [string, string[] | null][]): ConnectionPolicy {
	return { revision: 3, connectors: connectors.map(([provider, tenants]) => ({ provider, tenants })) };
}

test("a start's policy leaves out what it does not offer: the authorized set is what it admits", async () => {
	const within = scope();
	const [notes, repos] = [uuid7(), uuid7()];
	const layers = notesLayers(notes);
	layers.user?.grants.push({ connection: repos, kind: "repository", resource: "*", name: "", actions: ["read"], effect: "allow" });
	const start = (policy?: ConnectionPolicy) =>
		startOf(within, { authority: { connections: [notesConnection(notes), githubConnection(repos)], layers, ...(policy ? { policy } : {}) } });
	// Without a policy both are offered, as before.
	expect(await commands.startRun(start())).toMatchObject({ outcome: "accepted", authorized: [notes, repos] });
	// Notes' tenancy is unknown: a list refuses it, any admits it.
	expect(await commands.startRun(start(policyOf(["github", null], ["notes", ["acme"]])))).toMatchObject({ outcome: "accepted", authorized: [repos] });
	expect(await commands.startRun(start(policyOf(["notes", null])))).toMatchObject({ outcome: "accepted", authorized: [notes] });
	expect(await commands.startRun(start(policyOf()))).toMatchObject({ outcome: "accepted", authorized: [] });
});

test("a start admits a connection of a connector with a tenant per account only when the tenant Laravel sends is listed", async () => {
	const within = scope();
	const [ours, theirs, personal] = [uuid7(), uuid7(), uuid7()];
	const connections = [
		calendarConnection(ours, "example.com", "2026-10-18T09:00:00Z"),
		calendarConnection(theirs, "other.example", "2026-10-18T09:00:01Z"),
		calendarConnection(personal, null, "2026-10-18T09:00:02Z"),
	];
	const grants = connections.map(({ id }) => ({ connection: id, kind: "calendar", resource: "*", name: "", actions: ["read"], effect: "allow" as const }));
	const start = (policy?: ConnectionPolicy) =>
		startOf(within, { authority: { connections, layers: { ceiling: null, user: { restricted: true, revision: 1, grants }, agent: null }, ...(policy ? { policy } : {}) } });
	expect(await commands.startRun(start())).toMatchObject({ outcome: "accepted", authorized: [ours, theirs, personal] });
	expect(await commands.startRun(start(policyOf(["google_calendar", ["example.com"]])))).toMatchObject({ outcome: "accepted", authorized: [ours] });
	expect(await commands.startRun(start(policyOf(["google_calendar", ["other.example", "example.com"]])))).toMatchObject({ outcome: "accepted", authorized: [ours, theirs] });
	expect(await commands.startRun(start(policyOf(["google_calendar", null])))).toMatchObject({ outcome: "accepted", authorized: [ours, theirs, personal] });
});

test("a start's list of GitHub owners refuses a call on another owner's repository, and allows one on theirs", async () => {
	const within = scope();
	const provider = providerOf(env, within.workspace);
	await provider.reset();
	const connectionId = uuid7();
	await provider.laravelConnection(connectionId, { kind: "oauth2", secret: "gho-test", scopes: [], generation: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: "active" });
	const script: FakeScript = {
		turns: [
			{ tools: [{ name: "github_get_repository", arguments: { repository: "acme/app" } }] },
			{ tools: [{ name: "github_get_repository", arguments: { repository: "ada/notes" } }] },
			{ text: "Done." },
		],
	};
	const start = startOf(within, {
		message: { id: uuid7(), content: JSON.stringify({ fake: script }), attachments: [] },
		authority: {
			connections: [githubConnection(connectionId)],
			layers: { ceiling: null, user: { restricted: true, revision: 1, grants: [{ connection: connectionId, kind: "repository", resource: "*", name: "", actions: ["read"], effect: "allow" }] }, agent: null },
			policy: policyOf(["github", ["100"]]),
		},
	});
	await provider.laravelHold(start.run, heldRun(start));
	expect(await commands.startRun(start)).toMatchObject({ outcome: "accepted", authorized: [connectionId] });
	const state = await settled(start);
	const calls = state.facts.filter((fact: Fact) => fact.type === "run.tool_call").map((fact) => fact.data);
	expect(calls).toEqual([
		expect.objectContaining({ tool: "github_get_repository", decision: "allowed", count: 1 }),
		expect.objectContaining({ tool: "github_get_repository", decision: "denied", code: "POLICY_DENIED", message: "Your organization does not allow this GitHub owner." }),
	]);
	// ada/notes was resolved, never read.
	expect(asked).toEqual(["/repos/acme/app", "/repositories/1", "/repos/ada/notes"]);
	expect(state.facts.find((fact) => fact.type === "run.finished")).toMatchObject({ data: { status: "completed" } });
});
