// The test build's sandbox driver (src/faults/): `POST /api/faults/sandbox/<op>` behind the same token as
// the rest of the driver (routes.ts). It drives a Sandbox object of the test Worker (sandbox.ts, production's
// class with fault seams) named by the test, through the same calls the Conversation makes: prepare a
// container (start, harden, verify), commands and file operations through the ExecutionEnv with output
// coming back through an RpcTarget, pi's ExecutionEnv conformance suite, the probe, hydration, scans and
// checkpoints of a large folder, and the plan's Sandbox fault rows (test/account/sandbox.test.ts). The test keeps the fence
// a prepare answered and sends it back with each later operation. Never part of the production Worker.

import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { sandboxObject } from "../addressing.ts";
import { hex } from "../lib/bytes.ts";
import { uuid7 } from "../lib/random.ts";
import type { ExecRequest, ExecResult } from "../sandbox/commands.ts";
import { commandEnvironment, sandboxSpec, type SandboxSpec, WORKSPACE } from "../sandbox/constants.ts";
import type { Refused, SandboxFence } from "../sandbox/core.ts";
import { SandboxExecutionEnv } from "../sandbox/env.ts";
import type { HydratePlan } from "../sandbox/folder.ts";
import type { Delivered } from "../sandbox/output.ts";
import { prepareSandbox } from "../sandbox/session.ts";
import { outputSink } from "../sandbox/sink.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import type { FaultSandbox, SandboxFaults } from "./sandbox.ts";

/** The lab's sandboxes belong to a workspace of their own; their objects in R2 go under `lab/`. */
const LAB: WorkspaceRef = { id: "0199c000-0000-7000-8000-00000000fab1", jurisdiction: null };
const MiB = 1024 * 1024;

type Body = { [key: string]: unknown };
type Context = Parameters<SandboxExecutionEnv["readTextFile"]>[1];
const NONE = {} as Context;

function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && "refused" in value;
}

/** pi's conformance assertions, without a test runner. */
function deepEqual(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) return false;
	if (actual instanceof Uint8Array && expected instanceof Uint8Array) return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	const a = Object.keys(actual);
	const b = Object.keys(expected);
	if (a.length !== b.length) return false;
	return a.every((key) => deepEqual((actual as Body)[key], (expected as Body)[key]));
}

function partial(actual: unknown, expected: unknown): boolean {
	if (typeof expected !== "object" || expected === null) return Object.is(actual, expected);
	if (typeof actual !== "object" || actual === null) return false;
	return Object.entries(expected).every(([key, value]) => partial((actual as Body)[key], value));
}

const fail = (message: string): never => {
	throw new Error(message);
};

const assertions = {
	ok: (value: unknown, message?: string) => {
		if (!value) fail(message ?? "not ok");
	},
	strictEqual: (actual: unknown, expected: unknown) => {
		if (!Object.is(actual, expected)) fail(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
	},
	deepEqual: (actual: unknown, expected: unknown) => {
		if (!deepEqual(actual, expected)) fail(`${JSON.stringify(actual)} does not equal ${JSON.stringify(expected)}`);
	},
	partialDeepEqual: (actual: unknown, expected: unknown) => {
		if (!partial(actual, expected)) fail(`${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`);
	},
	greaterThan: (actual: number, expected: number) => {
		if (!(actual > expected)) fail(`${actual} is not above ${expected}`);
	},
	rejects: async (operation: Promise<unknown>, includes: string) => {
		try {
			await operation;
		} catch (error) {
			if (String(error).includes(includes)) return;
			fail(`rejected with ${String(error)}`);
		}
		fail("did not reject");
	},
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

export class SandboxLab {
	readonly #env: Env;
	readonly #exports: Cloudflare.Exports;

	constructor(env: Env, exports: Cloudflare.Exports) {
		this.#env = env;
		this.#exports = exports;
	}

	#sandbox(name: string): DurableObjectStub<FaultSandbox> {
		return sandboxObject(this.#env, this.#exports, LAB, name) as unknown as DurableObjectStub<FaultSandbox>;
	}

	async #exec(name: string, fence: SandboxFence, request: Partial<ExecRequest> & { command: string | string[] }) {
		const chunks: Delivered[] = [];
		const started = Date.now();
		const result = (await this.#sandbox(name).exec(
			fence,
			{ execId: uuid7(), cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 60, ...request },
			outputSink((chunk) => chunks.push(chunk)),
		)) as ExecResult | Refused;
		return {
			result,
			ms: Date.now() - started,
			stdout: chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join(""),
			stderr: chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join(""),
			skipped: chunks.filter((chunk) => chunk.skipped).length,
			chunks: chunks.length,
		};
	}

	#envOf(name: string, fence: SandboxFence, cwd?: string): SandboxExecutionEnv {
		return new SandboxExecutionEnv({ sandbox: this.#sandbox(name), fence, sink: outputSink, ...(cwd ? { cwd } : {}) });
	}

	async run(op: string, body: Body): Promise<unknown> {
		const name = String(body.name ?? "default");
		const sandbox = this.#sandbox(name);
		const fence = body.fence as SandboxFence;
		switch (op) {
			case "prepare": {
				const spec: SandboxSpec = sandboxSpec(LAB, name, { folderBytes: Number(body.folderBytes ?? 256 * MiB), folderEntries: Number(body.folderEntries ?? 10_000) }, null);
				const prepared = await prepareSandbox(sandbox, { runId: uuid7(), attempt: 1 }, spec);
				return { prepared, status: await sandbox.status() };
			}
			case "start": {
				// A start alone: the container runs, not yet hardened or verified.
				const spec: SandboxSpec = sandboxSpec(LAB, name, { folderBytes: 64 * MiB, folderEntries: 1000 }, null);
				const started = { runId: uuid7(), attempt: 1 };
				const answer = await sandbox.start(started, spec);
				return { started: answer, fence: "incarnation" in answer ? { ...started, incarnation: answer.incarnation } : null, status: await sandbox.status(), running: await sandbox.faultRunning() };
			}
			case "harden":
				return await sandbox.harden(fence);
			case "status":
				return { status: await sandbox.status(), running: await sandbox.faultRunning() };
			case "faults":
				await sandbox.faultSet(body.faults as SandboxFaults);
				return { ok: true };
			case "abort":
				try {
					await sandbox.faultAbort();
				} catch (error) {
					return { aborted: String(error) };
				}
				return { aborted: null };
			case "root":
				return await sandbox.faultRoot(String(body.script));
			case "destroy":
				return await sandbox.destroy(fence, String(body.reason ?? "lab"));
			case "kill-strays":
				return await sandbox.killStrays(fence);
			case "exec":
				return await this.#exec(name, fence, body.request as ExecRequest);
			case "lost": {
				// A command in flight when the object restarts: its call fails, its process is not the object's any more.
				const running = sandbox
					.exec(fence, { execId: uuid7(), command: "sleep 600", cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 0 }, outputSink(() => {}))
					.then(
						(result) => ({ result }),
						(error: unknown) => ({ error: String(error) }),
					);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const aborted = await sandbox.faultAbort().then(
					() => null,
					(error: unknown) => String(error),
				);
				return { call: await running, aborted };
			}
			case "cancel": {
				const execId = uuid7();
				const running = sandbox.exec(fence, { execId, command: String(body.command), cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 0 }, null);
				await new Promise((resolve) => setTimeout(resolve, Number(body.afterMs ?? 1000)));
				const started = Date.now();
				await sandbox.cancel(fence, execId);
				return { result: await running, ms: Date.now() - started };
			}
			case "fs": {
				const env = this.#envOf(name, fence);
				const path = String(body.path);
				const started = Date.now();
				const results = {
					readText: await env.readTextFile(path, NONE),
					write: await env.writeFile(path, "x", NONE),
					open: await env.openBinaryReader(path, undefined, NONE),
					exists: await env.exists(path, NONE),
				};
				const codes = Object.fromEntries(Object.entries(results).map(([key, result]) => [key, result.ok ? "ok" : result.error.code]));
				return { codes, ms: Date.now() - started };
			}
			case "write": {
				const result = await this.#envOf(name, fence).writeFile(String(body.path), new Uint8Array(Number(body.bytes)), NONE);
				return result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message };
			}
			case "scan":
				return await sandbox.scan(fence, { rehashAll: body.rehashAll === true });
			case "pull":
				return await sandbox.checkpoint(fence, { files: body.files as { path: string; sha256: string; size: number; key: string }[] });
			case "conformance": {
				const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];
				let n = 0;
				const cases = createEnvConformance({
					assertions,
					withEnv: async (use) => {
						const cwd = `${WORKSPACE}/conformance-${Date.now()}-${++n}`;
						getOrThrow(await this.#envOf(name, fence).createDir(cwd, undefined, NONE));
						await use(this.#envOf(name, fence, cwd));
					},
				});
				for (const entry of cases) {
					const started = Date.now();
					try {
						await entry.run();
						results.push({ name: entry.name, ok: true, ms: Date.now() - started });
					} catch (error) {
						results.push({ name: entry.name, ok: false, ms: Date.now() - started, error: String(error).slice(0, 500) });
					}
				}
				return { results };
			}
			case "timings": {
				const execs: number[] = [];
				for (let i = 0; i < 20; i++) execs.push((await this.#exec(name, fence, { command: "true" })).ms);
				const env = this.#envOf(name, fence);
				const files: number[] = [];
				for (let i = 0; i < 10; i++) {
					const started = Date.now();
					getOrThrow(await env.exists("/workspace", NONE));
					files.push(Date.now() - started);
				}
				return { execMedianMs: median(execs), execMs: execs, fsMedianMs: median(files), fsMs: files };
			}
			case "folder": {
				const prefix = `lab/${name}/${uuid7()}`;
				try {
					return await this.#folder(name, fence, prefix, Number(body.files ?? 500), Number(body.bytes ?? 50 * MiB));
				} finally {
					await this.#clear(prefix);
				}
			}
			case "cleanup":
				return { deleted: await this.#clear("lab/") };
			default:
				return null;
		}
	}

	/** Deletes every object under `prefix`; how many. */
	async #clear(prefix: string): Promise<number> {
		let deleted = 0;
		let cursor: string | undefined;
		do {
			const listed = await this.#env.FILES.list({ prefix, ...(cursor ? { cursor } : {}) });
			if (listed.objects.length) await this.#env.FILES.delete(listed.objects.map((object) => object.key));
			deleted += listed.objects.length;
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
		return deleted;
	}

	/** A folder of `count` files and `bytes` in all, through R2, hydration, a scan, changes, a scan and a checkpoint. */
	async #folder(name: string, fence: SandboxFence, prefix: string, count: number, bytes: number) {
		const sandbox = this.#sandbox(name);
		const each = Math.floor(bytes / count);
		const plan: HydratePlan = { versionId: null, files: [], dirs: ["empty"] };
		const putStarted = Date.now();
		const block = new Uint8Array(each);
		const puts: Promise<unknown>[] = [];
		for (let i = 0; i < count; i++) {
			for (let at = 0; at < each; at += 65536) crypto.getRandomValues(block.subarray(at, Math.min(each, at + 65536)));
			const copy = block.slice();
			const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
			const key = `${prefix}/${i}`;
			puts.push(this.#env.FILES.put(key, copy, { sha256 }));
			plan.files.push({ path: `d${i % 10}/f${i}.bin`, sha256, size: each, mode: i % 7 === 0 ? 0o755 : 0o644, mtime: 1_700_000_000_000 + i, key });
			if (puts.length >= 6) await Promise.all(puts.splice(0));
		}
		await Promise.all(puts);
		const putMs = Date.now() - putStarted;
		const hydrateStarted = Date.now();
		const hydrated = await sandbox.hydrate(fence, plan);
		const hydrateMs = Date.now() - hydrateStarted;
		const firstScanStarted = Date.now();
		const first = await sandbox.scan(fence, { rehashAll: false });
		const firstScanMs = Date.now() - firstScanStarted;
		const secondStarted = Date.now();
		await sandbox.scan(fence, { rehashAll: false });
		const secondScanMs = Date.now() - secondStarted;
		const changed = await this.#exec(name, fence, { command: 'for f in d*/f*.bin; do printf x >> "$f"; done; echo changed', timeoutSeconds: 120 });
		const thirdStarted = Date.now();
		const third = await sandbox.scan(fence, { rehashAll: false });
		const thirdScanMs = Date.now() - thirdStarted;
		if (isRefused(third) || !third.ok) return { hydrated, first, third, changed };
		const files = third.manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, size: third.sizes[file.path] as number, key: `${prefix}/out/${file.path}` }));
		const checkpointStarted = Date.now();
		const stored = await sandbox.checkpoint(fence, { files });
		const checkpointMs = Date.now() - checkpointStarted;
		const sample = await this.#env.FILES.head(files[0]?.key ?? "");
		const summary = (scan: unknown) =>
			isRefused(scan) || !(scan as { ok: boolean }).ok
				? scan
				: { files: (scan as { manifest: { files: unknown[] } }).manifest.files.length, dirs: (scan as { manifest: { dirs: string[] } }).manifest.dirs, warnings: (scan as { warnings: unknown }).warnings };
		return {
			count,
			each,
			putMs,
			hydrated,
			hydrateMs,
			first: summary(first),
			firstScanMs,
			secondScanMs,
			changed: { result: changed.result, ms: changed.ms },
			third: summary(third),
			thirdScanMs,
			stored: isRefused(stored) || !stored.ok ? stored : { files: stored.stored.length },
			checkpointMs,
			sampleSize: sample?.size ?? null,
			sampleChecksum: sample?.checksums.sha256 ? hex(new Uint8Array(sample.checksums.sha256)) : null,
			sampleExpected: files[0]?.sha256 ?? null,
		};
	}
}
