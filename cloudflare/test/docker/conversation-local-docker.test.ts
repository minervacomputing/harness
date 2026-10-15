// The checkpoint barrier with the real container (ARCHITECTURE.md: Checkpoints): an attempt's LocalRun
// (src/conversation/local-run.ts) over the Sandbox's logic and the sandbox image in a local Docker container
// (test/docker/sandbox-docker.ts), and the folder's store over node:sqlite (test/unit/files-support.ts). pi's
// own read, write, edit and bash run through the container's ExecutionEnv; checkpoints kill strays, scan as
// the agent's user, stream changed files into the bucket and record versions. Covered: results held until
// saved and released in order, read-only rounds without a checkpoint, the final rehash, the file tools
// failing on a FIFO within the file operations' limit, a detached writer killed before the scan, warnings for links and special files, a failed
// upload ending the attempt before any result is released, the run's upload budget failing the turn with
// its limit, and a second attempt hydrated from the first one's last checkpoint. Skipped without Docker or
// the image (`pnpm sandbox:image`).

import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, test } from "vitest";
import { FolderOverLimit, FolderUnavailable, LocalCalls, type LocalToolEvent, localToolSpecs, runGated } from "../../src/conversation/local.ts";
import { destroyRunSandbox, LocalRun, type SandboxPort } from "../../src/conversation/local-run.ts";
import { parseJson } from "../../src/lib/json.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { migrate, sqliteSql } from "../../src/lib/sql.ts";
import { sandboxSpec } from "../../src/sandbox/constants.ts";
import { SandboxCore } from "../../src/sandbox/core.ts";
import type { Delivered } from "../../src/sandbox/output.ts";
import { type BucketPort, CHECK_MISMATCH } from "../../src/sandbox/ports.ts";
import { SANDBOX_MIGRATIONS } from "../../src/sandbox/store.ts";
import type { RunId } from "../../src/shared/rpc.ts";
import { CONVERSATION, sha, WORKSPACE, World } from "../unit/files-support.ts";
import { DockerContainer, dockerReady, verified } from "./sandbox-docker.ts";
import { openDatabase } from "../unit/sqlite.ts";

const READY = dockerReady();
const WS = { id: WORKSPACE, jurisdiction: null } as const;
type Context = Parameters<ToolRegistration["execute"]>[2];
const context = { abortSignal: undefined, value: () => undefined, toString: () => "[Context test]" } as unknown as Context;

const containers: DockerContainer[] = [];
afterAll(() => {
	for (const container of containers) container.remove();
});

/** The Sandbox's put as R2 does it, into the World's bucket (which checks the SHA-256). */
function bucketOf(world: World): BucketPort {
	return {
		get: async (key, sha256) => {
			const object = await world.bucket.get(key);
			return object ? { size: object.size, body: verified(object.body, sha256) } : null;
		},
		put: async (key, body, options) => {
			await world.bucket.put(key, body, { sha256: options.sha256 });
		},
		check: async (body, options) => {
			if ((await sha(new Uint8Array(await new Response(body).arrayBuffer()))) !== options.sha256) throw new Error(CHECK_MISMATCH);
		},
	};
}

interface Rig {
	world: World;
	core: SandboxCore;
	container: DockerContainer;
	events: LocalToolEvent[];
	failures: Error[];
	saving: boolean[];
	local(runId: RunId): LocalRun;
	tool(local: LocalRun, name: string): (args: { [key: string]: unknown }) => Promise<ToolExecutionResult>;
}

function rig(settings: Partial<World["settings"]> = {}): Rig {
	const world = new World({ folderBytes: 8 * 1024 * 1024, folderEntries: 100, ...settings });
	// The folder's clock is the wall clock here: the container's mtimes are real.
	world.now = Date.now();
	const sql = sqliteSql(openDatabase());
	migrate(sql, SANDBOX_MIGRATIONS, Date.now());
	const container = new DockerContainer();
	containers.push(container);
	const core = new SandboxCore({
		container,
		sql,
		bucket: () => bucketOf(world),
		now: () => Date.now(),
		id: () => uuid7(),
		alarm: async () => {},
		background: () => {},
		log: () => {},
		cgroup: container.cgroup,
		// Short, so a FIFO's read and write end soon; the files here take milliseconds.
		fileSeconds: 5,
	});
	const made: Rig = {
		world,
		core,
		container,
		events: [],
		failures: [],
		saving: [],
		local(runId) {
			return new LocalRun({
				fence: world.fence(runId),
				spec: sandboxSpec(WS, CONVERSATION, { folderBytes: world.settings.folderBytes, folderEntries: world.settings.folderEntries }, null),
				deadline: null,
				sandbox: () => core as unknown as SandboxPort,
				folder: world.store,
				sink: (output: (chunk: Delivered) => void) => ({ output }),
				report: (event) => made.events.push(event),
				saving: (active) => made.saving.push(active),
				fail: (error) => {
					made.failures.push(error);
				},
				log: () => {},
			});
		},
		tool(local, name) {
			const spec = localToolSpecs({ deadline: null }).find((candidate) => candidate.name === name);
			if (!spec) throw new Error(`No tool ${name}`);
			return async (args) => {
				const env = await local.env();
				const outputs: string[] = [];
				const api = {
					env,
					outputWindow: undefined,
					output: (chunk: string | Uint8Array) => outputs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
					retainedOutput: () => ({ text: outputs.join(""), truncated: false }),
					diagnostic: () => {},
				} as unknown as ToolExecutionApi;
				const result = await runGated(local.calls, spec, args, api, context);
				return result.output ? result : { ...result, output: [{ type: "text", text: outputs.join("") }] };
			};
		},
	};
	return made;
}

const textOf = (result: ToolExecutionResult) => (result.output ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

describe.skipIf(!READY)("the checkpoint barrier with the container", { timeout: 180_000 }, () => {
	test("write, edit and read go through the container; two checkpoints, then the final one; the turn publishes the file", async () => {
		const made = rig();
		const runId = made.world.run();
		const local = made.local(runId);
		await made.tool(local, "write")({ path: "notes.txt", content: "apples 3\n" });
		await made.tool(local, "edit")({ path: "notes.txt", edits: [{ oldText: "3", newText: "4" }] });
		const read = await made.tool(local, "read")({ path: "notes.txt" });
		expect(textOf(read)).toContain("apples 4");
		expect(made.events.map((event) => [event.tool, event.summary, event.ok])).toEqual([
			["write", "notes.txt", true],
			["edit", "notes.txt", true],
			["read", "notes.txt", true],
		]);
		// One checkpoint per changing call, none for the read; each replaces the run's last.
		expect(made.saving).toEqual([true, false, true, false]);
		const checkpoint = made.world.runRow(runId)?.checkpoint_version_id;
		expect(checkpoint).not.toBeNull();
		await local.finish();
		expect(made.saving).toEqual([true, false, true, false, true, false]);
		// The rehash found nothing new: the same version.
		expect(made.world.runRow(runId)?.checkpoint_version_id).toBe(checkpoint);
		made.world.finish(runId);
		const changes = parseJson(made.world.runRow(runId)?.folder_changes ?? "null") as unknown as { added: { path: string }[] };
		expect(changes.added.map((item) => item.path)).toEqual(["notes.txt"]);
		expect(made.world.folder()).toBe(checkpoint);
		expect(made.failures).toEqual([]);
		expect(await destroyRunSandbox(made.core as unknown as SandboxPort, runId, "test over")).toBe(true);
		expect(made.container.running).toBe(false);
	});

	test("the file tools fail on a FIFO within the file operations' limit, and each is reported as failed", { timeout: 30_000 }, async () => {
		const made = rig();
		const local = made.local(made.world.run());
		await made.tool(local, "bash")({ command: "mkfifo pipe" });
		const started = Date.now();
		await expect(made.tool(local, "write")({ path: "pipe", content: "x" })).rejects.toThrow();
		await expect(made.tool(local, "edit")({ path: "pipe", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow();
		await expect(made.tool(local, "read")({ path: "pipe" })).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(made.events.map((event) => [event.tool, event.ok])).toEqual([
			["bash", true],
			["write", false],
			["edit", false],
			["read", false],
		]);
		// The FIFO is no file: the checkpoint leaves it out and says so.
		expect(made.world.warnings(local.fence.runId)).toEqual({ total: 1, items: [{ path: "pipe", reason: "special" }] });
	});

	test("a detached writer dies before the scan, links and special files are reported, and the folder holds still", async () => {
		const made = rig();
		const runId = made.world.run();
		const local = made.local(runId);
		await made.tool(local, "bash")({
			command: "mkdir real && echo inside > real/f && ln -s real linked && ln -s /etc etc && (setsid bash -c 'while :; do echo x >> log.txt; sleep 0.02; done' > /dev/null 2>&1 &); sleep 0.3; echo started",
		});
		expect(made.events.at(-1)).toMatchObject({ tool: "bash", ok: true, excerpt: "started\n" });
		// Killed by the checkpoint that released the call, so nothing writes any more.
		expect(made.container.shell("pgrep -u 1000 -c . || true").stdout.trim()).toBe("0");
		const size = made.container.shell("stat -c %s /workspace/log.txt").stdout.trim();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(made.container.shell("stat -c %s /workspace/log.txt").stdout.trim()).toBe(size);
		expect(made.world.warnings(runId)).toEqual({
			total: 2,
			items: [
				{ path: "etc", reason: "symlink" },
				{ path: "linked", reason: "symlink" },
			],
		});
		const version = made.world.runRow(runId)?.checkpoint_version_id as string;
		expect(Object.keys(made.world.store.entries(version).files)).toEqual(["log.txt", "real/f"]);
		expect(made.world.store.entries(version).files["log.txt"]?.size).toBe(Number(size));
	});

	test("a failed upload ends the attempt before the held result is released", async () => {
		const made = rig();
		const local = made.local(made.world.run());
		made.world.bucket.faults.put = () => "refuse";
		let failedFirst = false;
		const call = made.tool(local, "write")({ path: "a.txt", content: "a" });
		call.catch(() => {
			failedFirst = made.failures.length === 1;
		});
		await expect(call).rejects.toBeInstanceOf(FolderUnavailable);
		expect(failedFirst).toBe(true);
		expect(made.failures.map((error) => error.message)).toEqual(["The checkpoint was refused (upload): A file could not be saved."]);
		// No card: the result was never released.
		expect(made.events).toEqual([]);
		await expect(made.tool(local, "read")({ path: "a.txt" })).rejects.toBeInstanceOf(FolderUnavailable);
	});

	test("past the run's upload budget the turn fails with that limit", async () => {
		const made = rig({ runUploadBytes: 16 * 1024 });
		const local = made.local(made.world.run());
		await expect(made.tool(local, "bash")({ command: "head -c 20000 /dev/urandom > big.bin" })).rejects.toBeInstanceOf(FolderOverLimit);
		expect(made.failures).toHaveLength(1);
		expect((made.failures[0] as FolderOverLimit).limit).toBe("run_uploads");
	});

	test("a command that fills the folder gets ENOSPC at its size: the folder can never be saved over its limit", async () => {
		const made = rig({ folderBytes: 1024 * 1024 });
		const local = made.local(made.world.run());
		const filled = await made.tool(local, "bash")({ command: "head -c 2000000 /dev/zero > fill" });
		expect(filled.isError).toBe(true);
		expect(made.events.at(-1)?.excerpt).toMatch(/No space left on device[\s\S]*exited with code 1/);
		expect(made.failures).toEqual([]);
	});

	test("a read-only round takes no checkpoint, and a second attempt starts from the first one's last checkpoint", async () => {
		const made = rig();
		const runId = made.world.run();
		const first = made.local(runId);
		await made.tool(first, "write")({ path: "kept.txt", content: "kept\n" });
		const saved = made.world.runRow(runId)?.checkpoint_version_id;
		// The attempt dies (its object reset); the gate starts the next one.
		made.world.restart(runId);
		const second = made.local(runId);
		made.saving.length = 0;
		const read = await made.tool(second, "read")({ path: "kept.txt" });
		expect(textOf(read)).toBe("kept\n");
		expect(made.saving).toEqual([]);
		await second.finish();
		expect(made.saving).toEqual([]);
		expect(made.world.runRow(runId)?.checkpoint_version_id).toBe(saved);
		// The first attempt's container was replaced: its late calls are refused.
		await expect(made.tool(first, "read")({ path: "kept.txt" })).rejects.toThrow();
		await made.tool(second, "bash")({ command: "echo more >> kept.txt" });
		const after = made.world.runRow(runId)?.checkpoint_version_id as string;
		expect(after).not.toBe(saved);
		expect(made.world.store.version(after)?.attempt).toBe(2);
		made.world.finish(runId);
		expect(made.world.folder()).toBe(after);
	});

	test("a LocalCalls without a container never prepares one: a turn that only talks costs no checkpoint", async () => {
		const calls = new LocalCalls({ checkpoint: async () => {}, killStrays: async () => {}, fail: () => {}, report: () => {} });
		await calls.finish();
		expect(calls.changedEver).toBe(false);
	});
});
