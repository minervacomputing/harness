// The folder against the real image in a local Docker container (sandbox-docker.ts): hydration through
// `tar -x`, the scan through `find` and `sha256sum`, and checkpoints through `tar -c`, both through the
// Sandbox and by calling folder.ts and scan.ts directly with a forged index or scan. Names the manifest
// refuses, symbolic links (as entries and as parents), FIFOs, unreadable entries, hard links, sparse files and
// millisecond mtimes; shared blobs; short, long, failing and wrong bodies from the store; the tools' output
// cut short, malformed or followed by a failing exit; and the performance gate's timings. Skipped without
// Docker or the image: `pnpm sandbox:image` builds it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { commandEnvironment, WORKSPACE } from "../../src/sandbox/constants.ts";
import type { SandboxFence } from "../../src/sandbox/core.ts";
import { type HydratePlan, hydrate, upload } from "../../src/sandbox/folder.ts";
import type { BucketPort, ContainerPort } from "../../src/sandbox/ports.ts";
import type { Machine } from "../../src/sandbox/process.ts";
import { type FolderIndex, scan, type ScanResult } from "../../src/sandbox/scan.ts";
import { dockerReady, ready, type Rig, rig, run, sha256Hex } from "./sandbox-docker.ts";

const READY = dockerReady();
const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const blob = (data: Uint8Array) => ({ bytes: data, sha256: sha256Hex(data) });
/** Random bytes, as the store would hold for a file that does not compress. */
function random(length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536)));
	return out;
}

const rigs: Rig[] = [];
function track(made: Rig): Rig {
	rigs.push(made);
	return made;
}

afterAll(() => {
	for (const made of rigs) made.container.remove();
});

const machineOf = (made: Rig, container: ContainerPort = made.container): Machine => ({ container, cgroup: made.container.cgroup });
const LIMITS = { bytes: 8 * MiB, entries: 100 };
type Scanned = ScanResult & { ok: true };

/** Empties the folder, as root, hidden entries and unreadable ones included. */
function empty(made: Rig): void {
	made.container.shell(`chmod -R u+rwx ${WORKSPACE} 2>/dev/null; find ${WORKSPACE} -mindepth 1 -delete; rm -rf /tmp/outside`);
}

/**
 * The container, with the command of each wrapped process that `match` picks run through `rewrite` instead: a
 * tool whose output is cut short, malformed or followed by a failing exit.
 */
function rewriting(container: ContainerPort, match: (command: string[]) => boolean, rewrite: (command: string[]) => string[]): ContainerPort {
	return {
		get running() {
			return container.running;
		},
		start: (options) => container.start(options),
		exec: (argv, options) => {
			// The wrapper's argv: bash -c SCRIPT cgroup cwd timeout mode count, then the environment and the command.
			const at = 8 + Number(argv[7]);
			const command = argv.slice(at);
			const wrapped = argv[0] === "/bin/bash" && (argv[6] === "argv" || argv[6] === "shell");
			return container.exec(wrapped && match(command) ? [...argv.slice(0, at), ...rewrite(command)] : argv, options);
		},
		destroy: () => container.destroy(),
		setInactivityTimeout: (ms) => container.setInactivityTimeout(ms),
	};
}

/** `script` in place of the command, with the command's arguments from `from` on as its own ("$@"). */
const instead =
	(script: string, from = 0) =>
	(command: string[]) => ["/bin/sh", "-c", script, "sh", ...command.slice(from)];

describe.skipIf(!READY)("hydration", () => {
	let made: Rig;
	let fence: SandboxFence;
	const a = blob(bytes("alpha\n"));
	const b = blob(bytes("#!/bin/sh\necho beta\n"));

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made, { folderBytes: 64 * MiB, folderEntries: 100 });
		made.bucket.objects.set("k/a", a.bytes);
		made.bucket.objects.set("k/b", b.bytes);
	}, 120_000);
	afterEach(() => empty(made));

	test("writes each blob once, with modes, millisecond mtimes and empty directories, and a scan reads it back", { timeout: 60_000 }, async () => {
		const plan: HydratePlan = {
			versionId: null,
			files: [
				{ path: "docs/a.txt", sha256: a.sha256, size: a.bytes.length, mode: 0o644, mtime: 1_700_000_000_500, key: "k/a" },
				{ path: "copy of a.txt", sha256: a.sha256, size: a.bytes.length, mode: 0o755, mtime: 1_600_000_000_000, key: "k/a" },
				{ path: "bin/b.sh", sha256: b.sha256, size: b.bytes.length, mode: 0o755, mtime: 1_700_000_001_000, key: "k/b" },
				{ path: "-x", sha256: b.sha256, size: b.bytes.length, mode: 0o644, mtime: 0, key: "k/b" },
			],
			dirs: ["empty", "deep/er"],
		};
		const gets = made.bucket.gets;
		expect(await made.core.hydrate(fence, plan)).toEqual({ ok: true });
		expect(made.bucket.gets - gets).toBe(2);
		const scanned = await made.core.scan(fence, { rehashAll: false });
		expect(scanned).toEqual({
			ok: true,
			manifest: {
				files: [
					{ path: "-x", sha256: b.sha256, mode: 0o644, mtime: 0 },
					{ path: "bin/b.sh", sha256: b.sha256, mode: 0o755, mtime: 1_700_000_001_000 },
					{ path: "copy of a.txt", sha256: a.sha256, mode: 0o755, mtime: 1_600_000_000_000 },
					{ path: "docs/a.txt", sha256: a.sha256, mode: 0o644, mtime: 1_700_000_000_500 },
				],
				dirs: ["deep/er", "empty"],
			},
			sizes: { "-x": b.bytes.length, "bin/b.sh": b.bytes.length, "copy of a.txt": a.bytes.length, "docs/a.txt": a.bytes.length },
			warnings: { total: 0, items: [] },
		});
		// Workers RPC clones plain objects only: a map by path must keep Object's prototype.
		expect(Object.getPrototypeOf((scanned as { sizes: object }).sizes)).toBe(Object.prototype);
		// The files belong to the agent and run, and their mtimes are exact to the millisecond.
		expect((await run(made.core, fence, "./bin/b.sh && stat -c '%u %a %y' docs/a.txt")).stdout).toBe("beta\n1000 644 2023-11-14 22:13:20.500000000 +0000\n");
		expect(await made.core.hydrate(fence, { versionId: null, files: [], dirs: [] })).toMatchObject({ ok: false, reason: "not_empty" });
		empty(made);
		made.container.shell(`touch ${WORKSPACE}/.hidden`);
		expect(await made.core.hydrate(fence, { versionId: null, files: [], dirs: [] })).toMatchObject({ ok: false, reason: "not_empty" });
	});

	test("refuses an invalid plan before writing anything", { timeout: 30_000 }, async () => {
		const file = (path: string, size = a.bytes.length, sha256 = a.sha256) => ({ path, sha256, size, mode: 0o644 as const, mtime: 0, key: "k/a" });
		for (const plan of [
			{ files: [file("../escape")], dirs: [] },
			{ files: [file("a")], dirs: ["x//y"] },
			{ files: [file("a"), file("a")], dirs: [] },
			{ files: [file("a")], dirs: ["a"] },
			{ files: [file("a"), file("b", a.bytes.length + 1)], dirs: [] },
			{ files: [file("/abs")], dirs: [] },
		]) {
			expect(await made.core.hydrate(fence, { versionId: null, ...plan })).toMatchObject({ ok: false, reason: "invalid_path" });
		}
		expect((await run(made.core, fence, "ls -A")).stdout).toBe("");
	});

	test("a blob several paths hold is read once up to 8 MiB and again for each path past it, and the index holds the plan's hashes", { timeout: 60_000 }, async () => {
		const small = blob(random(300 * 1024));
		const medium = blob(random(2 * MiB));
		const large = blob(random(9 * MiB));
		made.bucket.objects.set("k/small", small.bytes);
		made.bucket.objects.set("k/medium", medium.bytes);
		made.bucket.objects.set("k/large", large.bytes);
		const holder = (path: string, of: { sha256: string; bytes: Uint8Array }, key: string, mode: 0o644 | 0o755, mtime: number) => ({ path, sha256: of.sha256, size: of.bytes.length, mode, mtime, key });
		const plan: HydratePlan = {
			versionId: null,
			files: [
				holder("s/1", small, "k/small", 0o644, 1_000),
				holder("s/2", small, "k/small", 0o755, 2_000),
				holder("s/3", small, "k/small", 0o644, 3_000),
				holder("m/1", medium, "k/medium", 0o644, 4_000),
				holder("m/2", medium, "k/medium", 0o755, 5_000),
				holder("l/1", large, "k/large", 0o644, 6_000),
				holder("l/2", large, "k/large", 0o755, 7_000),
			],
			dirs: [],
		};
		const gets = made.bucket.gets;
		const { result, index } = await hydrate(machineOf(made), made.bucket, plan, 100);
		expect(result).toEqual({ ok: true });
		expect(made.bucket.gets - gets).toBe(4);
		// Each path is a file of its own, not a link to another.
		const listed = (await run(made.core, fence, "find . -type f -printf '%P %m %T@ %n\\n' | sort; sha256sum s/* m/* l/*")).stdout;
		expect(listed).toBe(
			[
				"l/1 644 6.0000000000 1",
				"l/2 755 7.0000000000 1",
				"m/1 644 4.0000000000 1",
				"m/2 755 5.0000000000 1",
				"s/1 644 1.0000000000 1",
				"s/2 755 2.0000000000 1",
				"s/3 644 3.0000000000 1",
				...["s/1", "s/2", "s/3"].map((path) => `${small.sha256}  ${path}`),
				...["m/1", "m/2"].map((path) => `${medium.sha256}  ${path}`),
				...["l/1", "l/2"].map((path) => `${large.sha256}  ${path}`),
				"",
			].join("\n"),
		);
		expect([...(index as FolderIndex).entries()].map(([path, entry]) => [path, entry.sha256, entry.mtime, entry.size]).sort()).toEqual(
			plan.files.map((file) => [file.path, file.sha256, file.mtime, file.size]).sort(),
		);
	});

	test("fails on a body that is short, long, failing or of another hash, and on a tar that stops reading or fails", { timeout: 120_000 }, async () => {
		const good = blob(bytes("good"));
		const big = blob(random(2 * MiB));
		/** A store that claims `size` bytes and sends `body`, unchecked. */
		const lying = (body: ReadableStream<Uint8Array>, size: number): BucketPort => ({
			get: async () => ({ size, body }),
			put: async () => {},
			check: async () => {},
		});
		const stream = (data: Uint8Array) => new Blob([data as Uint8Array<ArrayBuffer>]).stream();
		/** A body that sends `data`, then fails on the next read. */
		const failing = (data: Uint8Array) => {
			let sent = false;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent) return controller.error(new Error("connection reset"));
					sent = true;
					controller.enqueue(data);
				},
			});
		};
		const planOf = (of: { sha256: string; bytes: Uint8Array }): HydratePlan => ({ versionId: null, files: [{ path: "f", sha256: of.sha256, size: of.bytes.length, mode: 0o644, mtime: 0, key: "k" }], dirs: [] });
		const cases: [string, BucketPort, HydratePlan, string][] = [
			["short, read whole", lying(stream(good.bytes.subarray(0, 3)), 4), planOf(good), "failed"],
			["long, read whole", lying(stream(bytes("goods")), 4), planOf(good), "failed"],
			["failing, read whole", lying(failing(good.bytes.subarray(0, 2)), 4), planOf(good), "failed"],
			["short, streamed", lying(stream(big.bytes.subarray(0, big.bytes.length - 1)), big.bytes.length), planOf(big), "failed"],
			["long, streamed", lying(stream(new Uint8Array([...big.bytes, 0])), big.bytes.length), planOf(big), "failed"],
			["failing, streamed", lying(failing(big.bytes.subarray(0, MiB)), big.bytes.length), planOf(big), "failed"],
		];
		for (const [name, bucket, plan, reason] of cases) {
			expect((await hydrate(machineOf(made), bucket, plan, 100)).result, name).toMatchObject({ ok: false, reason });
			empty(made);
		}
		// Another hash: the store's checked read refuses the bytes at their end.
		made.bucket.objects.set("k", big.bytes);
		expect((await hydrate(machineOf(made), made.bucket, { ...planOf(big), files: [{ ...(planOf(big).files[0] as HydratePlan["files"][number]), sha256: "4".repeat(64) }] }, 100)).result).toMatchObject({
			ok: false,
			reason: "mismatch",
		});
		empty(made);
		made.bucket.objects.set("k", good.bytes);
		const isTar = (command: string[]) => command[0] === "tar" && command[1] === "-x";
		for (const script of ["cat > /dev/null; exit 2", "head -c 100 > /dev/null", '"$@"; exit 3']) {
			const port = rewriting(made.container, isTar, instead(script));
			expect((await hydrate(machineOf(made, port), made.bucket, planOf(good), 100)).result, script).toMatchObject({ ok: false, reason: "failed" });
			empty(made);
		}
	});

	test("from a store that lacks a blob, holds the wrong one, or fails, fails", { timeout: 120_000 }, async () => {
		const good = bytes("good");
		made.bucket.objects.set("k/good", good);
		made.bucket.objects.set("k/short", bytes("bad"));
		const file = (path: string, key: string, size = good.length, sha256 = sha256Hex(good)) => ({ path, sha256, size, mode: 0o644 as const, mtime: 0, key });
		const many = Array.from({ length: 40 }, (_, i) => file(`f${i}`, "k/good"));
		expect(await made.core.hydrate(fence, { versionId: null, files: [...many, file("missing", "k/none", 4, "1".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "blob_missing" });
		empty(made);
		expect(await made.core.hydrate(fence, { versionId: null, files: [file("short", "k/short", 4, "2".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "mismatch" });
		empty(made);
		const down: BucketPort = { get: async () => Promise.reject(new Error("R2 is down")), put: async () => {}, check: async () => {} };
		expect((await hydrate(machineOf(made), down, { versionId: null, files: [file("a", "k/good")], dirs: [] }, 100)).result).toMatchObject({ ok: false, reason: "failed" });
		empty(made);
		// Directories alone need no store.
		expect((await hydrate(machineOf(made), down, { versionId: null, files: [], dirs: ["d"] }, 100)).result).toEqual({ ok: true });
		empty(made);
		// A hash the bytes do not have is the store's checked read refusing them.
		expect(await made.core.hydrate(fence, { versionId: null, files: [file("x", "k/good", 4, "3".repeat(64))], dirs: [] })).toMatchObject({ ok: false, reason: "mismatch" });
	});
});

describe.skipIf(!READY)("the scan", () => {
	let made: Rig;
	let fence: SandboxFence;

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
	}, 120_000);
	afterEach(() => empty(made));

	test("keeps regular files, hard links and sparse files, and says why it skipped everything else", { timeout: 60_000 }, async () => {
		const script = [
			"set -e",
			"echo shared > a.txt && touch -d @1700000000.123456789 a.txt && ln a.txt hard.txt && truncate -s 1M sparse.bin",
			"mkdir names && cd names",
			`touch "$(printf 'bad\\377')" "$(printf 'cafe\\314\\201')" "$(printf 'tab\\there')" "$(printf 'c1\\302\\205')"`,
			`mkdir "$(printf 'dir\\377')" && echo hidden > "$(printf 'dir\\377')/inner"`,
			"cd ..",
			"deep=$(printf 'd/%.0s' $(seq 32)) && mkdir -p \"${deep}d\" && touch \"${deep}f\"",
			"long=$(printf 'L%.0s' $(seq 250)) && mkdir -p \"$long/$long/$long/$long\" && touch \"$long/$long/$long/$long/$(printf 'x%.0s' $(seq 20))\" \"$long/$long/$long/$long/$(printf 'x%.0s' $(seq 21))\"",
			"mkdir -p /tmp/outside && echo secret > /tmp/outside/secret && ln -s /tmp/outside escape",
			"mkfifo pipe",
			"mkdir locked && echo x > locked/inner && chmod 0 locked && echo y > closed.txt && chmod 0 closed.txt",
		].join("\n");
		const prepared = await run(made.core, fence, script);
		expect(prepared.result).toMatchObject({ ok: true, exitCode: 0 });
		const scanned = (await made.core.scan(fence, { rehashAll: false })) as Scanned;
		expect(scanned.ok).toBe(true);
		const deep = Array.from({ length: 32 }, () => "d").join("/");
		const long = Array.from({ length: 4 }, () => "L".repeat(250)).join("/");
		const shared = sha256Hex(bytes("shared\n"));
		expect(scanned.manifest).toEqual({
			files: [
				{ path: `${long}/${"x".repeat(20)}`, sha256: sha256Hex(new Uint8Array(0)), mode: 0o644, mtime: expect.any(Number) },
				{ path: "a.txt", sha256: shared, mode: 0o644, mtime: 1_700_000_000_123 },
				{ path: "hard.txt", sha256: shared, mode: 0o644, mtime: 1_700_000_000_123 },
				{ path: "sparse.bin", sha256: sha256Hex(new Uint8Array(MiB)), mode: 0o644, mtime: expect.any(Number) },
			],
			dirs: [deep, "names"],
		});
		expect(scanned.sizes).toEqual({ [`${long}/${"x".repeat(20)}`]: 0, "a.txt": 7, "hard.txt": 7, "sparse.bin": MiB });
		expect(scanned.warnings).toEqual({
			total: 12,
			items: [
				{ path: `${long}/${"x".repeat(21)}`.slice(0, 1023) + "…", reason: "too_long" },
				{ path: "closed.txt", reason: "unreadable" },
				{ path: `${deep}/d`, reason: "too_deep" },
				{ path: `${deep}/f`, reason: "too_deep" },
				{ path: "escape", reason: "symlink" },
				{ path: "locked", reason: "unreadable" },
				{ path: "names/bad\ufffd", reason: "invalid_name" },
				{ path: "names/c1\ufffd", reason: "invalid_name" },
				{ path: "names/cafe\u0301", reason: "invalid_name" },
				{ path: "names/dir\ufffd", reason: "invalid_name" },
				{ path: "names/tab\ufffdhere", reason: "invalid_name" },
				{ path: "pipe", reason: "special" },
			],
		});
	});

	test("counts every entry against the limit, kept or not, and measures sizes in pages before hashing", { timeout: 60_000 }, async () => {
		const machine = machineOf(made);
		await run(made.core, fence, "mkdir dir && touch dir/a && ln -s a dir/b");
		expect((await scan(machine, new Map(), { ...LIMITS, entries: 2 }, false)).result).toEqual({ ok: false, limit: "folder_entries" });
		expect((await scan(machine, new Map(), { ...LIMITS, entries: 3 }, false)).result).toMatchObject({ ok: true });
		// A directory refused for its name counts once; what lies inside is left out, as if pruned.
		for (const name of ["x\\377", "cafe\\314\\201", "c1\\302\\205"]) {
			await run(made.core, fence, `rm -rf /workspace/*; mkdir "$(printf '${name}')" && touch "$(printf '${name}')/1" "$(printf '${name}')/2"`);
			expect((await scan(machine, new Map(), { ...LIMITS, entries: 2 }, false)).result, name).toMatchObject({ ok: true, manifest: { files: [], dirs: [] }, warnings: { total: 1 } });
		}
		empty(made);
		await run(made.core, fence, "printf a > a && printf b > b");
		expect((await scan(machine, new Map(), { ...LIMITS, bytes: 4096 }, false)).result).toEqual({ ok: false, limit: "folder_bytes" });
		expect((await scan(machine, new Map(), { ...LIMITS, bytes: 8192 }, false)).result).toMatchObject({ ok: true });
		// A sparse file is measured by its length, before anything reads it.
		await run(made.core, fence, "truncate -s 64G a");
		const started = performance.now();
		expect(await made.core.scan(fence, { rehashAll: false })).toEqual({ ok: false, limit: "folder_bytes" });
		expect(performance.now() - started).toBeLessThan(5_000);
		empty(made);
		// tmpfs runs out of inodes at the entry limit, so only hard links, which share one, could pass it; tmpfs counts a hard link as an inode too.
		const created = await run(made.core, fence, "mkdir many; for i in $(seq 1 120); do touch many/$i 2>/dev/null; done; ls many | wc -l");
		expect(Number(created.stdout.trim())).toBeGreaterThan(90);
		expect(Number(created.stdout.trim())).toBeLessThan(100);
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ ok: true });
		const linked = await run(made.core, fence, "rm -rf many; mkdir many; touch many/0; for i in $(seq 1 120); do ln many/0 many/$i 2>/dev/null; done; ls many | wc -l");
		expect(Number(linked.stdout.trim())).toBeGreaterThan(90);
		expect(Number(linked.stdout.trim())).toBeLessThan(100);
	});

	test("reuses an indexed hash unless the entry is racy, its file changed or everything is rehashed, and keeps an indexed mtime", { timeout: 60_000 }, async () => {
		const machine = machineOf(made);
		await run(made.core, fence, "printf a > a");
		const first = await scan(machine, new Map(), LIMITS, false);
		expect((first.result as Scanned).manifest.files[0]?.sha256).toBe(sha256Hex(bytes("a")));
		const entry = (first.index as FolderIndex).get("a");
		if (!entry) throw new Error("a is not indexed");
		const stale = "0".repeat(64);
		const hashOf = async (index: FolderIndex, rehashAll = false) => ((await scan(machine, index, LIMITS, rehashAll)).result as Scanned).manifest.files[0]?.sha256;
		expect(await hashOf(new Map([["a", { ...entry, sha256: stale, racy: true }]]))).toBe(sha256Hex(bytes("a")));
		const settled = new Map([["a", { ...entry, sha256: stale, racy: false }]]);
		expect(await hashOf(settled)).toBe(stale);
		expect(await hashOf(settled, true)).toBe(sha256Hex(bytes("a")));
		await run(made.core, fence, "printf b > a");
		expect(await hashOf(settled)).toBe(sha256Hex(bytes("b")));
		// As if hydration had rounded it: an indexed manifest mtime a millisecond off stays while the file's mtime does not change.
		const current = ((await scan(machine, new Map(), LIMITS, false)).index as FolderIndex).get("a") as typeof entry;
		const rounded = new Map([["a", { ...current, mtime: current.mtime + 1, racy: true }]]);
		expect(((await scan(machine, rounded, LIMITS, false)).result as Scanned).manifest.files[0]?.mtime).toBe(current.mtime + 1);
	});

	test("fails when find or sha256sum is cut short, says something malformed, or exits non-zero", { timeout: 60_000 }, async () => {
		await run(made.core, fence, "printf a > a");
		const isFind = (command: string[]) => command[0] === "/bin/sh" && command[3] === "scan";
		const isHash = (command: string[]) => command[0] === "xargs";
		// find's own arguments follow the shell's script and its name.
		const cases: [(command: string[]) => boolean, string, number][] = [
			[isFind, "printf 'x\\n'", 4],
			[isFind, "date +%s%N; printf '%s\\0' r f", 4],
			[isFind, 'date +%s%N; "$@" | head -c 40', 4],
			[isFind, 'date +%s%N; "$@"; exit 1', 4],
			[isFind, "date +%s%N; printf '%s\\0' r f 1 1.0000000000 1.0000000000 1 1 644 /etc/passwd", 4],
			[isHash, "cat > /dev/null; printf '%064d  /workspace/a' 0", 0],
			[isHash, "cat > /dev/null; printf '%064d  /workspace/b\\0' 0", 0],
			[isHash, "cat > /dev/null; printf '%064d  /workspace/a\\0%064d  /workspace/a\\0' 0 0", 0],
			[isHash, '"$@"; exit 1', 0],
		];
		for (const [match, script, from] of cases) {
			const port = rewriting(made.container, match, instead(script, from));
			expect((await scan(machineOf(made, port), new Map(), LIMITS, false)).result, script).toMatchObject({ ok: false, reason: "failed" });
		}
		expect((await scan(machineOf(made), new Map(), LIMITS, false)).result).toMatchObject({ ok: true });
	});

	test("folder steps need the folder to themselves", { timeout: 30_000 }, async () => {
		const running = made.core.exec(fence, { execId: "busy-1", command: "sleep 2", cwd: WORKSPACE, env: commandEnvironment(), timeoutSeconds: 10 }, null);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ refused: "busy" });
		await running;
		expect(await made.core.scan(fence, { rehashAll: false })).toMatchObject({ ok: true });
	});
});

describe.skipIf(!READY)("checkpoints", () => {
	let made: Rig;
	let fence: SandboxFence;

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made);
	}, 120_000);
	afterEach(() => empty(made));

	test("stream changed files into the bucket under their keys, checked against their hashes, only as the last scan saw them", { timeout: 60_000 }, async () => {
		await run(made.core, fence, "mkdir docs; printf 'new contents' > docs/new.txt; mkfifo pipe; ln -s /etc/passwd link; mkdir real; echo inside > real/f; ln -s real linked");
		const scanned = (await made.core.scan(fence, { rehashAll: false })) as Scanned;
		expect(scanned.ok).toBe(true);
		expect(scanned.warnings).toEqual({ total: 3, items: [{ path: "link", reason: "symlink" }, { path: "linked", reason: "symlink" }, { path: "pipe", reason: "special" }] });
		const file = scanned.manifest.files.find((entry) => entry.path === "docs/new.txt") as { sha256: string };
		expect(file.sha256).toBe(sha256Hex(bytes("new contents")));
		const stored = await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: "blobs/new" }] });
		expect(stored).toEqual({ ok: true, stored: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: "blobs/new" }] });
		expect(new TextDecoder().decode(made.bucket.objects.get("blobs/new"))).toBe("new contents");
		// A wrong hash is refused by the bucket; a size or a path the last scan did not report, before anything is read.
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: "0".repeat(64), size: 12, key: "blobs/bad" }] })).toMatchObject({ ok: false, reason: "mismatch" });
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 13, key: "blobs/bad" }] })).toMatchObject({ ok: false, reason: "changed" });
		for (const path of ["linked/f", "real/../docs/new.txt", "link", "pipe"]) {
			expect(await made.core.checkpoint(fence, { files: [{ path, sha256: file.sha256, size: 12, key: "blobs/bad" }] }), path).toMatchObject({ ok: false, reason: "changed" });
		}
		expect(made.bucket.objects.has("blobs/bad")).toBe(false);
		// Without a key (contents the conversation stores already) the bytes are hashed and nothing is written.
		const objects = made.bucket.objects.size;
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: null }] })).toEqual({
			ok: true,
			stored: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: null }],
		});
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: "0".repeat(64), size: 12, key: null }] })).toMatchObject({ ok: false, reason: "mismatch" });
		expect(made.bucket.objects.size).toBe(objects);
		// Anything run since the scan might have changed the folder.
		await run(made.core, fence, "true");
		expect(await made.core.checkpoint(fence, { files: [{ path: "docs/new.txt", sha256: file.sha256, size: 12, key: "blobs/again" }] })).toMatchObject({ ok: false, reason: "changed" });
	});

	test("many files in the planned order, empty, large, hard-linked, sparse and oddly named ones included", { timeout: 60_000 }, async () => {
		const long = `\u00e9/${"n".repeat(150)}`;
		await run(made.core, fence, `set -e; head -c 3145733 /dev/urandom > big.bin; ln big.bin big-link; truncate -s 1M sparse; : > empty; printf alpha > a; mkdir d; printf beta > d/b; mkdir \u00e9; printf long > ${long}; printf back > 'back\\slash'; printf dash > ./-`);
		const scanned = (await made.core.scan(fence, { rehashAll: false })) as Scanned;
		const hashes = new Map(scanned.manifest.files.map((entry) => [entry.path, entry.sha256]));
		const order = ["d/b", "big.bin", "empty", long, "-", "big-link", "back\\slash", "sparse", "a"];
		const files = order.map((path, i) => ({ path, sha256: hashes.get(path) as string, size: scanned.sizes[path] as number, key: i === 2 ? null : `c/${path}` }));
		expect(await made.core.checkpoint(fence, { files })).toEqual({ ok: true, stored: files });
		for (const file of files) {
			if (file.key === null) continue;
			const stored = made.bucket.objects.get(file.key) as Uint8Array;
			expect([file.path, stored.length, sha256Hex(stored)]).toEqual([file.path, file.size, file.sha256]);
		}
		expect(scanned.sizes).toMatchObject({ "big.bin": 3_145_733, "big-link": 3_145_733, sparse: MiB, empty: 0 });
	});

	test("anything but the planned regular file of the planned size, in order, is a mismatch", { timeout: 60_000 }, async () => {
		await run(made.core, fence, "printf abc > f; printf alpha > g; mkfifo p; ln -s f l; mkdir dir; mkdir -p /tmp/outside; printf abc > /tmp/outside/secret; ln -s /tmp/outside escape");
		const machine = machineOf(made);
		const contents: Record<string, string> = { f: "abc", g: "alpha" };
		const planned = (path: string, size: number) => ({ path, sha256: sha256Hex(bytes(contents[path] ?? "")), size, key: `x/${path}` });
		// As if the scan had reported each of these as a regular file of this size.
		const forged = (...files: { path: string; size: number }[]) => new Map(files.map((file) => [file.path, file.size]));
		// A symbolic link, a FIFO and a directory are entries without a body, so their size and hash match an
		// empty file's: only their type refuses them.
		for (const [path, size] of [
			["l", 0],
			["p", 0],
			["dir", 0],
			["missing", 3],
			["f", 4],
		] as const) {
			expect(await upload(machine, made.bucket, { files: [planned(path, size)] }, forged({ path, size })), path).toMatchObject({ ok: false, reason: "mismatch", path });
		}
		expect(await upload(machine, made.bucket, { files: [planned("f", 3), planned("p", 0)] }, forged({ path: "f", size: 3 }, { path: "p", size: 0 }))).toMatchObject({ ok: false, reason: "mismatch", path: "p" });
		// A hard link stored as a link, not as the file: an entry without a body, of another type.
		await run(made.core, fence, ": > e; ln e e2");
		const asLink = rewriting(made.container, (command) => command[0] === "tar" && command[1] === "-c", (command) => command.filter((argument) => argument !== "--hard-dereference"));
		expect(await upload(machineOf(made, asLink), made.bucket, { files: [planned("e", 0), planned("e2", 0)] }, forged({ path: "e", size: 0 }, { path: "e2", size: 0 }))).toMatchObject({
			ok: false,
			reason: "mismatch",
			path: "e2",
		});
		// An archive whose entries are reordered, repeated, missing or one too many; the files after the first
		// wrong entry are never stored.
		const both = forged({ path: "f", size: 3 }, { path: "g", size: 5 });
		const listing = (names: string) => rewriting(made.container, (command) => command[0] === "tar" && command[1] === "-c", instead(`cat > /dev/null; printf '${names}' | "$@"`));
		for (const [names, plan, path] of [
			["g\\0f\\0", ["f", "g"], "f"],
			["f\\0f\\0", ["f", "g"], "g"],
			["f\\0", ["f", "g"], "g"],
			["f\\0g\\0", ["f"], ""],
		] as const) {
			made.bucket.objects.delete("x/g");
			const files = plan.map((name) => planned(name, contents[name]?.length ?? 0));
			expect(await upload(machineOf(made, listing(names)), made.bucket, { files }, both), names).toMatchObject({ ok: false, reason: "mismatch", path });
			expect(made.bucket.objects.has("x/g"), names).toBe(false);
		}
		// A path through a symbolic link is never one the scan reports, and the Sandbox refuses it before reading.
		expect(await upload(machine, made.bucket, { files: [planned("escape/secret", 3)] }, forged({ path: "f", size: 3 }))).toMatchObject({ ok: false, reason: "changed" });
		expect(await upload(machine, made.bucket, { files: [planned("f", 3)] }, null)).toMatchObject({ ok: false, reason: "changed" });
		expect(await upload(machine, made.bucket, { files: [planned("f", 3), planned("f", 3)] }, forged({ path: "f", size: 3 }))).toMatchObject({ ok: false, reason: "failed" });
		// The archive cut short, malformed, followed by more bytes, or from a tar that fails.
		const isTar = (command: string[]) => command[0] === "tar" && command[1] === "-c";
		const plan = { files: [planned("f", 3)] };
		const scanned = forged({ path: "f", size: 3 });
		for (const [script, reason] of [
			["cat > /dev/null; head -c 1024 /dev/zero", "mismatch"],
			["cat > /dev/null; printf garbage", "mismatch"],
			['"$@" | head -c 1600', "mismatch"],
			['"$@"; printf x', "mismatch"],
			['"$@"; exit 3', "failed"],
		] as const) {
			const port = rewriting(made.container, isTar, instead(script));
			expect(await upload(machineOf(made, port), made.bucket, plan, scanned), script).toMatchObject({ ok: false, reason });
		}
		expect(await upload(machine, made.bucket, plan, scanned)).toMatchObject({ ok: true });
	});
});

describe.skipIf(!READY)("timings", () => {
	let made: Rig;
	let fence: SandboxFence;
	const limits = { folderBytes: 256 * MiB, folderEntries: 20_000 };

	beforeAll(async () => {
		made = track(rig());
		fence = await ready(made, limits);
	}, 120_000);
	afterEach(() => empty(made));

	const timed = async <T>(operation: () => Promise<T>): Promise<[T, number]> => {
		const started = performance.now();
		const result = await operation();
		return [result, Math.round(performance.now() - started)];
	};

	test("hydration of 1,000 files and of large shared blobs, a scan of 10,000 entries, a checkpoint of 500 files", { timeout: 600_000 }, async () => {
		const files: HydratePlan["files"] = [];
		for (let i = 0; i < 1000; i++) {
			const data = random(1024);
			const of = blob(data);
			made.bucket.objects.set(`h/${i}`, data);
			files.push({ path: `h/${String(i).padStart(4, "0")}`, sha256: of.sha256, size: data.length, mode: 0o644, mtime: 1_700_000_000_000 + i, key: `h/${i}` });
		}
		const [small, hydrateSmall] = await timed(() => made.core.hydrate(fence, { versionId: null, files, dirs: [] }));
		expect(small).toEqual({ ok: true });
		empty(made);
		const large = [blob(random(16 * MiB)), blob(random(16 * MiB))];
		large.forEach((of, i) => made.bucket.objects.set(`L/${i}`, of.bytes));
		const shared = large.flatMap((of, i) => [0, 1, 2].map((copy) => ({ path: `L/${i}-${copy}`, sha256: of.sha256, size: of.bytes.length, mode: 0o644 as const, mtime: 0, key: `L/${i}` })));
		const [big, hydrateLarge] = await timed(() => made.core.hydrate(fence, { versionId: null, files: shared, dirs: [] }));
		expect(big).toEqual({ ok: true });
		empty(made);

		await run(made.core, fence, "set -e; mkdir s; head -c 10000000 /dev/urandom | split -b 1000 -a 4 - s/; sleep 1.1");
		const [first, scanAll] = await timed(() => made.core.scan(fence, { rehashAll: false }));
		expect(first).toMatchObject({ ok: true });
		expect((first as Scanned).manifest.files).toHaveLength(10_000);
		const [indexed, scanIndexed] = await timed(() => made.core.scan(fence, { rehashAll: false }));
		expect(indexed).toEqual(first);
		const scanned = (await made.core.scan(fence, { rehashAll: false })) as Scanned;
		const picked = scanned.manifest.files.slice(0, 500).map((file, i) => ({ path: file.path, sha256: file.sha256, size: scanned.sizes[file.path] as number, key: `cp/${i}` }));
		const [stored, checkpoint] = await timed(() => made.core.checkpoint(fence, { files: picked }));
		expect(stored).toMatchObject({ ok: true });
		console.log(
			`timings (ms): hydrate 1,000 files of 1 KiB ${hydrateSmall}; hydrate two 16 MiB blobs at three paths each ${hydrateLarge}; scan 10,001 entries hashing all ${scanAll}, from the index ${scanIndexed}; checkpoint 500 files of 1,000 bytes ${checkpoint}`,
		);
	});
});
