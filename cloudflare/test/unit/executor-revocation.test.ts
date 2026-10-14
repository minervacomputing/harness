// Strict revocation inside one call (ARCHITECTURE.md: Strict revocation): the executor checks the run right before every
// provider request a call makes, not only before the call starts, so a revocation that lands while one of the
// call's requests is in flight, while its client opens, or while prepare() reads, lets no later request of
// that call out, and the run is checked again once the policy allowed the call, so a replaced attempt's call
// stops even when execute() sends nothing. The call then ends RUN_ENDED, unrecorded. In the Conversation
// Durable Object a revocation also aborts the call, which stops the request in flight; these checks are what
// stops a connector that goes on after a failed request (a fallback, a second page).

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type Connector, type Prepared, type ProviderOutput, defineOperation } from "../../src/gateway/connector.ts";
import { ProviderHTTP } from "../../src/gateway/http.ts";
import type { Json } from "../../src/lib/json.ts";
import { FOLDER, MIXED, Scenario, jsonResponse, userGrants } from "./executor-fakes.ts";

const Id = () => z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/);
const Both = z.strictObject({ first: Id(), second: Id() });
const Found = z.strictObject({ name: Id() });
const Folder = z.object({ id: z.string(), name: z.string() });

/** A provider whose every request is recorded, with a hook that runs while the request is in flight. */
class Provider {
	paths: string[] = [];
	during: ((path: string) => void) | null = null;

	readonly fetch: typeof fetch = async (input, init) => {
		const path = new URL(new Request(input as RequestInfo, init as RequestInit).url).pathname;
		this.paths.push(path);
		this.during?.(path);
		await Promise.resolve();
		if (path === "/lookup/notes") return jsonResponse(200, { id: "inbox", name: "Inbox" });
		const id = path.split("/").pop() as string;
		return jsonResponse(200, { id, name: id });
	};
}

/**
 * Operations whose calls make two requests (two in execute(), or one in prepare() and one in execute()),
 * and one whose execute() sends nothing: it answers with what prepare() read.
 */
function twoStep(): Connector<ProviderHTTP> {
	return {
		slug: "twostep",
		name: "Two step",
		kinds: [{ id: FOLDER, label: "Folder", actions: ["read"], wildcard: true }],
		actions: [{ id: "read", label: "Read" }],
		auth: { type: "oauth2", app: "twostep", authorizeUrl: "https://twostep.example/authorize", tokenUrl: "https://twostep.example/token", scopes: ["files"] },
		operations: [
			defineOperation<z.output<typeof Both>>({
				name: "read_both",
				title: "Read two folders",
				description: "Reads one folder, then another.",
				input: Both,
				needs: [[FOLDER, "read"]],
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [
							{ need: binding.resource(FOLDER, data.first), action: "read" },
							{ need: binding.resource(FOLDER, data.second), action: "read" },
						],
						async execute(): Promise<ProviderOutput> {
							const records = [];
							for (const id of [data.first, data.second]) {
								const folder = await http.parsed({ method: "GET", path: `/folders/${id}` }, Folder);
								records.push({ resource: binding.resource(FOLDER, folder.id), data: folder as { [key: string]: Json } });
							}
							return { records };
						},
					};
				},
			}),
			defineOperation<z.output<typeof Found>>({
				name: "read_found",
				title: "Read a folder by name",
				description: "Looks a folder up by its name, then reads it.",
				input: Found,
				needs: [[FOLDER, "read"]],
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					const found = await http.parsed({ method: "GET", path: `/lookup/${data.name}` }, Folder);
					return {
						requirements: [{ need: binding.resource(FOLDER, found.id), action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const folder = await http.parsed({ method: "GET", path: `/folders/${found.id}` }, Folder);
							return { records: [{ resource: binding.resource(FOLDER, folder.id), data: folder as { [key: string]: Json } }] };
						},
					};
				},
			}),
			defineOperation<z.output<typeof Found>>({
				name: "read_looked_up",
				title: "Look a folder up",
				description: "Looks a folder up by its name, and answers with what it found.",
				input: Found,
				needs: [[FOLDER, "read"]],
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					const found = await http.parsed({ method: "GET", path: `/lookup/${data.name}` }, Folder);
					return {
						requirements: [{ need: binding.resource(FOLDER, found.id), action: "read" }],
						async execute(): Promise<ProviderOutput> {
							return { records: [{ resource: binding.resource(FOLDER, found.id), data: found as { [key: string]: Json } }] };
						},
					};
				},
			}),
		],
		client: (secret, io) => new ProviderHTTP(io, { provider: "Two step", baseUrl: "https://twostep.example", headers: { Authorization: `Bearer ${secret}` } }),
		async account() {
			return { id: "acct-1", label: "Account" };
		},
		async discover() {
			return { items: [] };
		},
		async describe() {
			return {};
		},
	};
}

async function start(provider: Provider) {
	return Scenario.start({
		connectors: [twoStep()],
		connections: [{ id: MIXED, provider: "twostep", payload: { kind: "oauth2", access_token: "t", refresh_token: null, scopes: ["files"] } }],
		user: userGrants(MIXED, FOLDER, { inbox: ["read"], archive: ["read"] }),
		fetch: provider.fetch,
	});
}

const ENDED = { ok: false, error: { code: "RUN_ENDED", message: "This run is no longer active." }, event: null };

describe("a revocation during a call", () => {
	test("while the first of its two requests is in flight: the second is never sent", async () => {
		const provider = new Provider();
		const run = await start(provider);
		provider.during = () => run.runs.set(run.runId, { revoked: true });
		expect(await run.call("twostep_read_both", { first: "inbox", second: "archive" })).toEqual(ENDED);
		expect(provider.paths).toEqual(["/folders/inbox"]);
		expect(run.events).toEqual([]);
	});

	test("while prepare() reads: execute()'s request is never sent", async () => {
		const provider = new Provider();
		const run = await start(provider);
		provider.during = (path) => {
			if (path.startsWith("/lookup/")) run.runs.set(run.runId, { revoked: true });
		};
		expect(await run.call("twostep_read_found", { name: "notes" })).toEqual(ENDED);
		expect(provider.paths).toEqual(["/lookup/notes"]);
		expect(run.events).toEqual([]);
	});

	test("while its credentials are opened: neither prepare()'s request nor execute()'s is sent", async () => {
		for (const [tool, args] of [
			["twostep_read_found", { name: "notes" }],
			["twostep_read_both", { first: "inbox", second: "archive" }],
		] as const) {
			const provider = new Provider();
			const run = await start(provider);
			const open = run.credentials.open.bind(run.credentials);
			run.credentials.open = async (lease) => {
				run.runs.set(run.runId, { revoked: true });
				return open(lease);
			};
			expect(await run.call(tool, args)).toEqual(ENDED);
			expect(provider.paths).toEqual([]);
			expect(run.events).toEqual([]);
		}
	});

	test("an attempt replaced while prepare() reads: the call ends RUN_ENDED, though execute() would send nothing", async () => {
		// The check after the policy: no request of execute() would be refused, and the run is still active
		// under its new attempt, so only that check stops the replaced attempt's call (ARCHITECTURE.md: Attempts and recovery, Fencing).
		const provider = new Provider();
		const run = await start(provider);
		provider.during = () => run.replace();
		expect(await run.call("twostep_read_looked_up", { name: "notes" })).toEqual(ENDED);
		expect(provider.paths).toEqual(["/lookup/notes"]);
		expect(run.events).toEqual([]);
	});

	test("a call that is not revoked makes both requests", async () => {
		const provider = new Provider();
		const run = await start(provider);
		expect((await run.ok("twostep_read_both", { first: "inbox", second: "archive" })).result.count).toBe(2);
		expect((await run.ok("twostep_read_found", { name: "notes" })).result.count).toBe(1);
		expect((await run.ok("twostep_read_looked_up", { name: "notes" })).result.count).toBe(1);
		expect(provider.paths).toEqual(["/folders/inbox", "/folders/archive", "/lookup/notes", "/folders/inbox", "/lookup/notes"]);
	});
});
