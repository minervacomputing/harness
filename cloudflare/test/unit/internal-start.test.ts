// A Laravel start before anything is stored (src/internal/start.ts): the message's own refusals, the compile from the
// command's raw authority (gateway/tools.ts `startSnapshot`), the history and the prompt.

import type { StartRun } from "@minerva/contract/internal";
import { beforeAll, describe, expect, test } from "vitest";
import { CLIPPED, MESSAGE_LIMIT } from "../../src/conversation/history.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { COMPILER_VERSION, startSnapshot } from "../../src/gateway/tools.ts";
import { catalogOf } from "../../src/internal/catalog.ts";
import { inputDigest, messageRefusal, prepareStart, promptOf } from "../../src/internal/start.ts";
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

	test("prompts with a note naming its attachments as the folder holds them", () => {
		expect(promptOf("Read these", [{ path: "a (2).txt", size: 1, mediaType: "text/plain" }])).toBe("Read these\n\n[The user attached a (2).txt to this message, in your folder.]");
		expect(promptOf("Hello", [])).toBe("Hello");
	});

	test("the input's digest names the whole command", async () => {
		expect(await inputDigest(command())).toBe(await inputDigest(command()));
		expect(await inputDigest(command({ user: "43" }))).not.toBe(await inputDigest(command()));
	});
});
