// A Laravel start before anything is stored (src/internal/start.ts): the message's own refusals, the compile from the
// command's raw authority (gateway/tools.ts `startSnapshot`), the history and the prompt.

import type { StartRun } from "@minerva/contract/internal";
import { beforeAll, describe, expect, test } from "vitest";
import { CLIPPED, MESSAGE_LIMIT } from "../../src/conversation/history.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { COMPILER_VERSION, startSnapshot } from "../../src/gateway/tools.ts";
import { catalogOf } from "../../src/internal/catalog.ts";
import type { HeldCall, HoldDecision } from "../../src/gateway/holds.ts";
import { type HeldRun, approvalOf, approvalRefusal, inputDigest, messageRefusal, prepareStart, promptOf } from "../../src/internal/start.ts";
import { FOLDER, keyedConnector, mixedConnector } from "./fakes.ts";

const ORG = "0199a000-0000-7000-8000-0000000000e1";
const WS = "0199a000-0000-7000-8000-0000000000e2";
const CONVERSATION = "0199a000-0000-7000-8000-0000000000e3";
const RUN = "0199a000-0000-7000-8000-0000000000e4";
const AGENT = "0199a000-0000-7000-8000-0000000000e5";
const MINE = "0199a000-0000-7000-8000-000000000001";
const THEIRS = "0199a000-0000-7000-8000-000000000002";
const KEYED = "0199a000-0000-7000-8000-00000000000f";
const EARLIER = "0199a000-0000-7000-8000-0000000000e6";
// Monday, 2026-10-12 14:03:59 UTC.
const NOW = Date.UTC(2026, 9, 12, 14, 3, 59);

let registry: Registry;
beforeAll(async () => {
	registry = await Registry.create([mixedConnector(), keyedConnector()]);
});

function command(change: Partial<StartRun> = {}): StartRun {
	return {
		scope: { environment: "test", organization: ORG, workspace: WS },
		conversation: CONVERSATION,
		run: RUN,
		user: "42",
		agent: { id: AGENT, instructions: "Be brief.", model: "default" },
		message: { id: "0199a000-0000-7000-8000-0000000000e7", content: "Hello", attachments: [] },
		history: [],
		authority: {
			connections: [
				{ id: MINE, provider: "mixed", owner: "42", status: "active", createdAt: "2026-10-12T09:00:00+00:00", scopes: ["files", "labels"], revision: 1 },
				{ id: THEIRS, provider: "mixed", owner: "7", status: "active", createdAt: "2026-10-12T09:00:01+00:00", scopes: ["files", "labels"], revision: 1 },
				{ id: KEYED, provider: "keyed", owner: null, status: "active", createdAt: "2026-10-12T09:00:02+00:00", scopes: null, revision: 2 },
			],
			layers: {
				ceiling: { restricted: false, revision: 3, grants: [{ connection: KEYED, kind: "account", resource: KEYED, name: "Account", actions: ["read"], effect: "deny" }] },
				user: {
					restricted: true,
					revision: 4,
					grants: [
						{ connection: MINE, kind: FOLDER, resource: "*", name: "Every folder", actions: ["read", "read"], effect: "allow" },
						{ connection: KEYED, kind: "account", resource: KEYED, name: "Account", actions: ["read"], effect: "allow" },
					],
				},
				agent: null,
			},
		},
		...change,
	};
}

describe("the compile", () => {
	test("is startSnapshot over the command's raw authority", async () => {
		const prepared = await prepareStart(registry, command(), { now: NOW, runTimeoutMs: 600_000 });
		const grant = { subject: "42", resourceName: "Every folder", effect: "allow" as const };
		const expected = startSnapshot(registry, {
			workspaceId: WS,
			conversationId: CONVERSATION,
			userId: "42",
			agent: { id: AGENT, instructions: "Be brief.", modelAlias: "default" },
			connections: [
				{ id: MINE, provider: "mixed", ownerId: "42", status: "active", createdAt: Date.parse("2026-10-12T09:00:00Z"), scopes: ["files", "labels"] },
				{ id: THEIRS, provider: "mixed", ownerId: "7", status: "active", createdAt: Date.parse("2026-10-12T09:00:01Z"), scopes: ["files", "labels"] },
				{ id: KEYED, provider: "keyed", ownerId: null, status: "active", createdAt: Date.parse("2026-10-12T09:00:02Z"), scopes: null },
			],
			layers: {
				ceiling: {
					restricted: false,
					grants: [{ layer: "ceiling", subject: null, connectionId: KEYED, kind: "account", resourceId: KEYED, resourceName: "Account", actions: ["read"], effect: "deny" }],
				},
				user: {
					restricted: true,
					grants: [
						{ layer: "user", connectionId: MINE, kind: FOLDER, resourceId: "*", actions: ["read"], ...grant },
						{ layer: "user", subject: "42", connectionId: KEYED, kind: "account", resourceId: KEYED, resourceName: "Account", actions: ["read"], effect: "allow" },
					],
				},
				agent: null,
			},
			providerOf: (id) => ({ [MINE]: "mixed", [THEIRS]: "mixed", [KEYED]: "keyed" })[id] ?? null,
			createdAt: NOW,
			runTimeoutMs: 600_000,
		});
		expect(prepared.snapshot).toEqual(expected);
		expect(prepared.snapshot.deadline).toBe(NOW + 600_000);
		// The user's own connection is reached; another user's is not usable, and the ceiling's deny shuts the keyed one.
		expect(prepared.snapshot.connectionIds).toEqual([MINE]);
		expect(prepared.catalog).toBe((await catalogOf(registry)).version);
		expect(prepared.compiler).toBe(COMPILER_VERSION);
		// Raised when grants gained asks.
		expect(COMPILER_VERSION).toBe("4");
	});

	test("its digest names the snapshot: the same compile has the same one, another compile another", async () => {
		const first = await prepareStart(registry, command(), { now: NOW, runTimeoutMs: null });
		const again = await prepareStart(registry, command({ history: [] }), { now: NOW, runTimeoutMs: null });
		expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(again.digest).toBe(first.digest);
		const later = await prepareStart(registry, command(), { now: NOW + 60_000, runTimeoutMs: null });
		expect(later.digest).not.toBe(first.digest);
		const restricted = command();
		restricted.authority.layers.user = { restricted: true, revision: 5, grants: [] };
		const none = await prepareStart(registry, restricted, { now: NOW, runTimeoutMs: null });
		expect(none.snapshot.connectionIds).toEqual([]);
		expect(none.digest).not.toBe(first.digest);
	});

	test("a policy that offers every connector with any tenant compiles to the snapshot and digest of a start without one", async () => {
		const none = await prepareStart(registry, command(), { now: NOW, runTimeoutMs: null });
		const open = command();
		open.authority.policy = { revision: 1, connectors: [{ provider: "mixed", tenants: null }, { provider: "keyed", tenants: null }] };
		const any = await prepareStart(registry, open, { now: NOW, runTimeoutMs: null });
		expect(none.snapshot.tools.map((tool) => tool.name)).toEqual(["mixed_list_folders"]);
		expect(any.snapshot).toEqual(none.snapshot);
		expect(any.snapshot).not.toHaveProperty("tenants");
		expect(any.digest).toBe(none.digest);
	});

	test("selects and clips the history as history.ts does, without the run's own message", async () => {
		const long = "x".repeat(MESSAGE_LIMIT + 10);
		const history: StartRun["history"] = [
			{ id: "0199a000-0000-7000-8000-0000000000f2", role: "assistant", content: "Second", attachments: [], run: EARLIER, createdAt: "2026-10-12T10:00:05+00:00", changes: null },
			{ id: "0199a000-0000-7000-8000-0000000000f1", role: "user", content: long, attachments: [{ path: "a.txt", size: 1, mediaType: "text/plain" }], run: EARLIER, createdAt: "2026-10-12T10:00:00+00:00", changes: null },
			{ id: "0199a000-0000-7000-8000-0000000000f3", role: "user", content: "Hello", attachments: [], run: RUN, createdAt: "2026-10-12T10:01:00+00:00", changes: null },
		];
		const prepared = await prepareStart(registry, command({ history }), { now: NOW, runTimeoutMs: null });
		expect(prepared.history).toEqual([
			{ role: "user", content: `${"x".repeat(MESSAGE_LIMIT)}${CLIPPED}` },
			{ role: "assistant", content: "Second" },
		]);
	});
});

describe("the message", () => {
	const limits = { messageAttachments: 2 };
	const file = (upload: string) => ({ upload, name: "a.txt", size: 1, mediaType: "text/plain" });
	const message = (content: string, attachments: ReturnType<typeof file>[]) => command({ message: { id: "0199a000-0000-7000-8000-0000000000e7", content, attachments } });

	test("is refused when it has nothing, too many files, one twice, or one outside the workspace's staging", () => {
		expect(messageRefusal(message(" \n", []), limits)).toMatchObject({ code: "EMPTY_MESSAGE" });
		expect(messageRefusal(message("", [file(`uploads/${WS}/a`), file(`uploads/${WS}/b`), file(`uploads/${WS}/c`)]), limits)).toMatchObject({
			code: "TOO_MANY_ATTACHMENTS",
			message: "Attach at most 2 files to a message.",
		});
		expect(messageRefusal(message("", [file(`uploads/${WS}/a`), file(`uploads/${WS}/a`)]), limits)).toMatchObject({ code: "ATTACHED_TWICE" });
		for (const key of [`uploads/${ORG}/a`, `uploads/${WS}/`, `blobs/${WS}/${CONVERSATION}/a`, `uploads/${WS}`]) {
			expect(messageRefusal(message("", [file(key)]), limits), key).toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
		}
		expect(messageRefusal(message("", [file(`uploads/${WS}/a`)]), limits)).toBeNull();
		expect(messageRefusal(message("Hi", []), limits)).toBeNull();
	});

	test("prompts with a note naming its attachments as the folder holds them, then one with the run's start in UTC", () => {
		// Monday, 2026-10-12 14:03:59 UTC.
		const at = Date.UTC(2026, 9, 12, 14, 3, 59);
		const sent = "[The user sent this message on Monday, 2026-10-12 14:03 UTC.]";
		expect(promptOf("Read these", [{ path: "a (2).txt", size: 1, mediaType: "text/plain" }], at)).toBe(
			`Read these\n\n[The user attached a (2).txt to this message, in your folder.]\n\n${sent}`,
		);
		expect(promptOf("Hello", [], at)).toBe(`Hello\n\n${sent}`);
		expect(promptOf("", [{ path: "a.txt", size: 1, mediaType: "text/plain" }], at)).toBe(`[The user attached a.txt to this message, in your folder.]\n\n${sent}`);
	});

	test("the input's digest names the whole command", async () => {
		expect(await inputDigest(command())).toBe(await inputDigest(command()));
		expect(await inputDigest(command({ user: "43" }))).not.toBe(await inputDigest(command()));
	});
});

describe("the approval", () => {
	const HELD = "0199a000-0000-7000-8000-0000000000e8";
	const OTHER = "0199a000-0000-7000-8000-0000000000e9";
	const unknown = { outcome: "refused", code: "APPROVAL_UNKNOWN", message: "These decisions do not match the actions waiting for approval." };
	const decided = { outcome: "refused", code: "APPROVAL_DECIDED", message: "These actions were already answered." };

	function hold(position: number, decision: HoldDecision = { state: "open" }, userId = "42"): HeldCall {
		return {
			runId: HELD,
			position,
			key: String(position).repeat(64),
			write: String(position).repeat(32),
			userId,
			tool: "mixed_save_file",
			label: "Mixed: Save a file",
			connection: MINE,
			provider: "mixed",
			operation: "save_file",
			contract: "fingerprint",
			arguments: `{"name":"${position}"}`,
			requirements: [],
			decision,
			createdAt: NOW - 60_000,
		};
	}

	const run = (holds: HeldCall[], attended = true): HeldRun => ({ attended, holds });
	const deciding = (...decisions: [number, boolean][]) => command({ approval: { run: HELD, decisions: decisions.map(([position, approve]) => ({ position, approve })) } });

	test("a start without one passes, whatever the conversation holds", () => {
		expect(approvalRefusal(command(), null)).toBeNull();
		expect(approvalOf(command(), run([hold(1)]))).toBeNull();
	});

	test("deciding every open hold of an attended run of the user passes, also beside holds decided earlier", () => {
		expect(approvalRefusal(deciding([1, true], [2, false]), run([hold(1), hold(2)]))).toBeNull();
		expect(approvalRefusal(deciding([2, true], [1, true]), run([hold(1), hold(2)]))).toBeNull();
	});

	test.each([
		["a run the conversation does not hold", null],
		["a run nobody attended", run([hold(1), hold(2)], false)],
		["a position the run holds nothing at", run([hold(1)])],
		["another user's hold", run([hold(1), hold(2, { state: "open" }, "7")])],
		["one open hold left out", run([hold(1), hold(2), hold(3)])],
	] as const)("%s is APPROVAL_UNKNOWN", (_name, held) => {
		expect(approvalRefusal(deciding([1, true], [2, true]), held)).toEqual(unknown);
	});

	test.each([
		["used", { state: "used", by: OTHER, approve: true, outcome: null }],
		["declined", { state: "used", by: OTHER, approve: false }],
		["closed", { state: "closed", by: OTHER }],
	] as const)("a hold already %s is APPROVAL_DECIDED, before a set that no longer matches", (_name, decision) => {
		expect(approvalRefusal(deciding([1, true], [2, true]), run([hold(1, decision), hold(2)]))).toEqual(decided);
		expect(approvalRefusal(deciding([1, true]), run([hold(1, decision), hold(2)]))).toEqual(decided);
	});

	test("a hold of another user is APPROVAL_UNKNOWN even when it was decided", () => {
		expect(approvalRefusal(deciding([1, true]), run([hold(1, { state: "closed", by: OTHER }, "7")]))).toEqual(unknown);
	});

	test("the snapshot copies each decided hold whole with its decision, in position order, and the digest names it", async () => {
		const start = deciding([2, false], [1, true]);
		const held = run([hold(1), hold(2)]);
		const approval = approvalOf(start, held);
		const { decision: _one, createdAt: _at1, ...first } = hold(1);
		const { decision: _two, createdAt: _at2, ...second } = hold(2);
		expect(approval).toEqual({ run: HELD, holds: [{ ...first, approve: true }, { ...second, approve: false }] });
		const plain = await prepareStart(registry, command(), { now: NOW, runTimeoutMs: null });
		const prepared = await prepareStart(registry, start, { now: NOW, runTimeoutMs: null, approval });
		expect(prepared.snapshot).toEqual({ ...plain.snapshot, approval });
		expect(prepared.digest).not.toBe(plain.digest);
		const declined = await prepareStart(registry, deciding([2, false], [1, false]), { now: NOW, runTimeoutMs: null, approval: approvalOf(deciding([2, false], [1, false]), held) });
		expect(declined.digest).not.toBe(prepared.digest);
	});
});
