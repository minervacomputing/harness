// The Sandbox's pure parts: paths as Node resolves them, the wrapper's argv and prefix, the output pump's
// window and pacing, pi's spill thresholds, the hardening's report, the verification's decisions, and what
// the image must agree with (cloudflare/container/Dockerfile).

import { describe, expect, test } from "vitest";
import type { SandboxSpec } from "../../src/contracts/sandbox.ts";
import { COMMAND_PATH, sandboxSpec, workspaceBytes } from "../../src/sandbox/constants.ts";
import { hardeningArgv, hardeningReport, mounts, verificationReport } from "../../src/sandbox/hardening.ts";
import { type Delivered, newlines, OutputPump, SpillCounter, splitTail, StreamText, utf8Length } from "../../src/sandbox/output.ts";
import { join, normalize, resolve, resolvePath } from "../../src/sandbox/paths.ts";
import { olderThan, EMPTY } from "../../src/sandbox/store.ts";
import { ACK, NAK, readAdmission, timeoutArgument, wrapperArgv } from "../../src/sandbox/wrapper.ts";

interface NodePath {
	posix: { normalize(path: string): string; join(...parts: string[]): string; resolve(...parts: string[]): string };
}
interface NodeFs {
	readFileSync(path: string, encoding: "utf8"): string;
}
const node = (globalThis as unknown as { process: { getBuiltinModule(id: "node:path"): NodePath; getBuiltinModule(id: "node:fs"): NodeFs } }).process;
const posix = node.getBuiltinModule("node:path").posix;
const read = (path: string) => node.getBuiltinModule("node:fs").readFileSync(new URL(path, import.meta.url).pathname, "utf8");

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

describe("paths", () => {
	test("normalize, join and resolve are Node's", () => {
		const next = random(11);
		const parts = ["a", "b", ".", "..", "", "/", "//", "...", ".a", "a.", "é", " "];
		for (let i = 0; i < 3000; i++) {
			let path = next() < 0.5 ? "/" : "";
			const length = Math.floor(next() * 7);
			for (let j = 0; j < length; j++) path += parts[Math.floor(next() * parts.length)] + (next() < 0.7 ? "/" : "");
			expect(normalize(path)).toBe(posix.normalize(path));
			expect(join(path, "x", path)).toBe(posix.join(path, "x", path));
			expect(resolve("/workspace/sub", path)).toBe(posix.resolve("/workspace/sub", path));
		}
		expect(join()).toBe(".");
		expect(join("/a/b", "..")).toBe("/a");
	});

	test("pi's resolvePath, with the container's HOME", () => {
		expect(resolvePath("/workspace", "notes.txt")).toBe("/workspace/notes.txt");
		expect(resolvePath("/workspace", "../etc/passwd")).toBe("/etc/passwd");
		expect(resolvePath("/workspace", "~")).toBe("/tmp/home");
		expect(resolvePath("/workspace", "~/x/../y")).toBe("/tmp/home/y");
		expect(resolvePath("/workspace", "~user")).toBe("/workspace/~user");
		expect(resolvePath("/workspace", "file:///tmp/a%20b")).toBe("/tmp/a b");
		expect(resolvePath("/workspace", "file://localhost/x")).toBe("/x");
		// What fileURLToPath refuses stays an ordinary path.
		expect(resolvePath("/workspace", "file:///a%2Fb")).toBe("/workspace/file:/a%2Fb");
		expect(resolvePath("/workspace", "file://host/x")).toBe("/workspace/file:/host/x");
		expect(resolvePath("/workspace", "/abs//dir/")).toBe("/abs/dir");
	});
});

describe("the wrapper", () => {
	test("the command, its directory and its environment are arguments, never part of the script", () => {
		const argv = wrapperArgv("/sys/fs/cgroup/agent", { command: "echo $HOME; rm -rf /", cwd: "/workspace", env: { PATH: "/bin", HOME: "/tmp/home" }, timeoutSeconds: 600 });
		expect(argv.slice(0, 2)).toEqual(["/bin/bash", "-c"]);
		const script = argv[2] as string;
		expect(script).not.toContain("rm -rf");
		expect(script).toContain('echo $$ > "$cgroup/cgroup.procs" || exit 125');
		// Privileges are dropped before the caller's environment is installed: no LD_PRELOAD reaches root.
		expect(script).toContain(
			'exec /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- /usr/bin/env -i -- "${environment[@]}" /usr/bin/timeout -k 5 "$seconds" "$@"',
		);
		expect(script.indexOf("/usr/bin/setpriv")).toBeLessThan(script.indexOf("/usr/bin/env -i"));
		expect(argv.slice(3)).toEqual(["/sys/fs/cgroup/agent", "/workspace", "600", "shell", "2", "PATH=/bin", "HOME=/tmp/home", "/bin/bash", "-c", "echo $HOME; rm -rf /"]);
		const direct = wrapperArgv("/sys/fs/cgroup/agent", { command: ["printf", "%s", "a b"], cwd: "/", env: {}, timeoutSeconds: 0 });
		expect(direct.slice(3)).toEqual(["/sys/fs/cgroup/agent", "/", "0", "argv", "0", "printf", "%s", "a b"]);
	});

	test("names and values that execve cannot take are refused", () => {
		const run = (env: { [name: string]: string }, command: string | string[] = "true") => () => wrapperArgv("/c", { command, cwd: "/", env, timeoutSeconds: 1 });
		expect(run({ "A=B": "x" })).toThrow(TypeError);
		expect(run({ A: "x\u0000y" })).toThrow(TypeError);
		expect(run({}, "a\u0000b")).toThrow(TypeError);
		expect(run({}, [])).toThrow(TypeError);
	});

	test("timeouts are plain decimals", () => {
		expect(timeoutArgument(0)).toBe("0");
		expect(timeoutArgument(0.1)).toBe("0.1");
		expect(timeoutArgument(600)).toBe("600");
		expect(timeoutArgument(1e-7)).toBe("0");
		expect(timeoutArgument(1e21)).toBe("1000000000000000000000");
		expect(() => timeoutArgument(-1)).toThrow(RangeError);
		expect(() => timeoutArgument(Number.NaN)).toThrow(RangeError);
	});

	test("the first byte says whether the command started", () => {
		const bytes = (...values: number[]) => Uint8Array.from(values);
		expect(readAdmission(bytes(), false)).toBeNull();
		expect(readAdmission(bytes(), true)).toEqual({ admission: { started: false, reason: "admission" }, rest: bytes() });
		expect(readAdmission(bytes(ACK, 0x68, 0x69), false)).toEqual({ admission: { started: true }, rest: bytes(0x68, 0x69) });
		expect(readAdmission(bytes(NAK, 0x63, 0x77), false)).toBeNull();
		const cwd = [NAK, ...new TextEncoder().encode("cwd\n")];
		expect(readAdmission(Uint8Array.from(cwd), false)).toEqual({ admission: { started: false, reason: "cwd" }, rest: bytes() });
		const missing = [NAK, ...new TextEncoder().encode("missing\nx")];
		expect(readAdmission(Uint8Array.from(missing), false)).toEqual({ admission: { started: false, reason: "missing" }, rest: bytes(0x78) });
		// Anything else first is not the wrapper speaking.
		expect(readAdmission(bytes(0x41), false)).toMatchObject({ admission: { started: false, reason: "admission" } });
	});
});

describe("output", () => {
	test("each stream drops one leading byte order mark, as pi's StreamDecoder does", () => {
		const text = new StreamText();
		expect(text.decode(Uint8Array.from([0xef, 0xbb]))).toBe("");
		expect(text.decode(Uint8Array.from([0xbf, 0x61, 0xef, 0xbb, 0xbf]))).toBe("a﻿");
		expect(text.decode(Uint8Array.from([0xe2, 0x82]))).toBe("");
		expect(text.decode()).toBe("�");
	});

	test("the tail split is the shortest suffix past the window, at a character boundary", () => {
		const next = random(5);
		const units = ["a", "é", "€", "😀", "\n", "\n\n", "�"];
		for (let i = 0; i < 2000; i++) {
			let text = "";
			const length = Math.floor(next() * 60);
			for (let j = 0; j < length; j++) text += units[Math.floor(next() * units.length)];
			const window = { maxBytes: Math.floor(next() * 30), maxLines: Math.floor(next() * 6) };
			const { head, tail } = splitTail(text, window);
			expect(head + tail).toBe(text);
			const past = (part: string) => utf8Length(part) > window.maxBytes || newlines(part) > window.maxLines;
			if (head !== "") {
				expect(past(tail)).toBe(true);
				// One character less would not be past the window.
				const shorter = [...tail].slice(1).join("");
				expect(past(shorter)).toBe(false);
			}
		}
	});

	test("without a window every chunk is delivered in arrival order, a stream's adjacent chunks joined", async () => {
		const delivered: Delivered[] = [];
		let release: () => void = () => {};
		const pump = new OutputPump({
			deliver: (chunk) => {
				delivered.push(chunk);
				return new Promise<void>((resolve) => (release = resolve));
			},
			now: () => 0,
			sleep: async () => {},
		});
		pump.push("stdout", "a");
		pump.push("stdout", "b");
		pump.push("stderr", "c");
		pump.push("stdout", "d");
		await Promise.resolve();
		release();
		const flushed = pump.flush();
		for (let i = 0; i < 10; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			release();
		}
		await flushed;
		expect(delivered).toEqual([
			{ stream: "stdout", text: "a" },
			{ stream: "stdout", text: "b" },
			{ stream: "stderr", text: "c" },
			{ stream: "stdout", text: "d" },
		]);
	});

	test("with a window, what is past it is skipped and counted, and deliveries are paced", async () => {
		let now = 0;
		const delivered: { at: number; chunk: Delivered }[] = [];
		const window = { maxBytes: 20, maxLines: 2, minIntervalMs: 100, bytesPerSecond: 1000 };
		const pump = new OutputPump({
			window,
			deliver: async (chunk) => {
				delivered.push({ at: now, chunk });
			},
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		let all = "";
		for (let i = 0; i < 200; i++) {
			const line = `line ${i}\n`;
			all += line;
			pump.push(i % 3 === 0 ? "stderr" : "stdout", line);
			if (i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await pump.flush();
		let bytes = 0;
		let lines = 0;
		let tail = "";
		for (const { chunk } of delivered) {
			if (chunk.skipped) {
				bytes += chunk.skipped.bytes;
				lines += chunk.skipped.newlines;
				expect(utf8Length(chunk.text) > window.maxBytes || newlines(chunk.text) > window.maxLines).toBe(true);
				tail = "";
			}
			bytes += utf8Length(chunk.text);
			lines += newlines(chunk.text);
			tail += chunk.text;
		}
		expect(bytes).toBe(utf8Length(all));
		expect(lines).toBe(200);
		expect(all.endsWith(tail)).toBe(true);
		expect(tail.endsWith("line 198\nline 199\n")).toBe(true);
		expect(delivered.some(({ chunk }) => chunk.skipped)).toBe(true);
		// The second delivery waited at least the interval after the first.
		const times = delivered.map(({ at }) => at);
		for (let i = 1; i < times.length - 1; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(0);
	});

	test("with a window, output behind a slow caller is dropped as it arrives, so little is ever held", async () => {
		let release: () => void = () => {};
		const delivered: Delivered[] = [];
		const window = { maxBytes: 64, maxLines: 2, minIntervalMs: 0, bytesPerSecond: 1e9 };
		const pump = new OutputPump({
			window,
			deliver: async (chunk) => {
				delivered.push(chunk);
				if (delivered.length === 1) await new Promise<void>((resolve) => (release = resolve));
			},
			now: () => 0,
			sleep: async () => {},
		});
		pump.push("stdout", "first\n");
		await Promise.resolve();
		let pushed = 0;
		for (let i = 0; i < 100_000; i++) {
			const text = `${"x".repeat(250)}\n`;
			pushed += text.length;
			pump.push(i % 2 ? "stdout" : "stderr", text);
			expect(pump.queued).toBeLessThan(70_000);
		}
		release();
		await pump.flush();
		let bytes = 0;
		for (const chunk of delivered) bytes += (chunk.skipped?.bytes ?? 0) + utf8Length(chunk.text);
		expect(bytes).toBe(pushed + "first\n".length);
		expect(delivered.length).toBeLessThan(5);
	});

	test("without a window, a producer waits while the queue is full", async () => {
		let release: () => void = () => {};
		const pump = new OutputPump({ deliver: () => new Promise<void>((resolve) => (release = resolve)), now: () => 0, sleep: async () => {} });
		pump.push("stdout", "a");
		await Promise.resolve();
		pump.push("stdout", "x".repeat(3 * 1024 * 1024));
		let roomy = false;
		const room = pump.room().then(() => (roomy = true));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(roomy).toBe(false);
		release();
		await room;
		expect(roomy).toBe(true);
		release();
		const flushed = pump.flush();
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await flushed;
	});

	test("a failed delivery drops later output", async () => {
		const pump = new OutputPump({ deliver: async () => Promise.reject(new Error("gone")), now: () => 0, sleep: async () => {} });
		pump.push("stdout", "x");
		await pump.flush();
		expect(pump.failed).toBe(true);
		pump.push("stdout", "y");
		await pump.flush();
	});

	test("pi's spill thresholds: bytes, or lines with the last chunk's unterminated line", () => {
		const bytes = (text: string) => new TextEncoder().encode(text);
		const lines = new SpillCounter({ afterBytes: 1000, afterLines: 2 });
		expect(lines.passed(bytes("a\n"))).toBe(false);
		expect(lines.passed(bytes("b"))).toBe(false);
		expect(lines.passed(bytes("\nc"))).toBe(true);
		const size = new SpillCounter({ afterBytes: 4, afterLines: 100 });
		expect(size.passed(bytes("abcd"))).toBe(false);
		expect(size.passed(bytes("e"))).toBe(true);
		expect(new SpillCounter({ afterBytes: 0, afterLines: 0 }).passed(new Uint8Array(0))).toBe(false);
	});
});

describe("hardening", () => {
	const spec: SandboxSpec = sandboxSpec({ id: "w", jurisdiction: null }, "c", { folderBytes: 268_435_456 + 100, folderEntries: 10_000 }, null);

	test("the script takes every value as an argument", () => {
		const argv = hardeningArgv(spec, "/sys/fs/cgroup/agent");
		expect(argv.slice(3)).toEqual([
			String(268_435_456),
			"10001",
			String(256 * 1024 * 1024),
			"256",
			String(1024 ** 3 + 268_435_456 + 256 * 1024 * 1024),
			"/sys/fs/cgroup/agent",
			"1000",
			"1000",
			"/workspace",
			"/tmp",
			"/tmp/home",
			"/tmp/matplotlib",
		]);
		expect(argv[2]).toMatch(/^set -eu\n/);
		expect(workspaceBytes(4095)).toBe(0);
	});

	test("a failure names the step it started last", () => {
		expect(hardeningReport(0, "step workspace\nstep tmp\nstep home_dirs\nstep cgroup\nstep readonly_root\nstep done\n", "")).toMatchObject({ ok: true, failed: null });
		for (const step of ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"]) {
			const steps = ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"];
			const out = steps.slice(0, steps.indexOf(step) + 1).map((name) => `step ${name}\n`).join("");
			expect(hardeningReport(1, out, "mount: permission denied")).toMatchObject({ ok: false, failed: step });
		}
		// Exit 0 without reaching the end is a failure too.
		expect(hardeningReport(0, "step workspace\n", "")).toMatchObject({ ok: false, failed: "workspace" });
		expect(hardeningReport(137, "", "")).toMatchObject({ ok: false, failed: "workspace" });
	});

	const goodFacts = (overrides: Record<string, unknown> = {}) => ({
		mountinfo: [
			"1 0 0:1 / / ro,relatime - btrfs /dev/vda rw",
			"2 1 0:2 / /workspace rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=262144k,nr_inodes=10001,mode=755,uid=1000,gid=1000",
			"3 1 0:3 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=262144k",
		].join("\n"),
		"/tmp": { dir: true, uid: 0, gid: 0, mode: 0o1777 },
		"/tmp/home": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
		"/tmp/matplotlib": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
		"pids.max": "256",
		"memory.max": String(1024 ** 3 + 268_435_456 + 256 * 1024 * 1024),
		tmp_exec: "EACCES",
		etc_write: "EROFS",
		dropped: {
			exit: 0,
			stdout: `\u0006Name:\tcat\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n---\n0::/agent\n`,
		},
		...overrides,
	});

	test("every postcondition is decided from the facts", () => {
		const report = verificationReport(spec, "/sys/fs/cgroup/agent", 0, JSON.stringify(goodFacts()));
		expect(report.checks.map((check) => [check.name, check.ok])).toEqual([
			["workspace_mount", true],
			["tmp_noexec", true],
			["home_dirs", true],
			["root_readonly", true],
			["cgroup_limits", true],
			["dropped_privileges", true],
		]);
		expect(report.ok).toBe(true);
	});

	test("any fact out of place fails its check, and an unreadable report fails", () => {
		const fails = (overrides: Record<string, unknown>, name: string) => {
			const report = verificationReport(spec, "/sys/fs/cgroup/agent", 0, JSON.stringify(goodFacts(overrides)));
			expect(report.ok).toBe(false);
			expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([name]);
		};
		const info = goodFacts().mountinfo;
		fails({ mountinfo: info.replace("nr_inodes=10001", "nr_inodes=10002") }, "workspace_mount");
		fails({ mountinfo: info.replace("/workspace rw,nosuid,nodev,relatime", "/workspace rw,nosuid,nodev,noexec,relatime") }, "workspace_mount");
		fails({ mountinfo: `${info}\n4 2 0:4 / /workspace rw,relatime - tmpfs tmpfs rw` }, "workspace_mount");
		fails({ mountinfo: info.replace("/tmp rw,nosuid,nodev,noexec,relatime", "/tmp rw,nosuid,nodev,relatime") }, "tmp_noexec");
		fails({ tmp_exec: "ran" }, "tmp_noexec");
		fails({ "/tmp/home": { dir: true, uid: 0, gid: 0, mode: 0o755 } }, "home_dirs");
		fails({ "/tmp/matplotlib": "ENOENT" }, "home_dirs");
		fails({ mountinfo: info.replace("/ ro,relatime", "/ rw,relatime") }, "root_readonly");
		fails({ etc_write: "written" }, "root_readonly");
		fails({ "pids.max": "max" }, "cgroup_limits");
		fails({ "memory.max": "max" }, "cgroup_limits");
		const dropped = goodFacts().dropped as { exit: number; stdout: string };
		fails({ dropped: { ...dropped, stdout: dropped.stdout.replace("CapBnd:\t0000000000000000", "CapBnd:\t000001ffffffffff") } }, "dropped_privileges");
		fails({ dropped: { ...dropped, stdout: dropped.stdout.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0") } }, "dropped_privileges");
		fails({ dropped: { ...dropped, stdout: dropped.stdout.replace("Groups:\t\n", "Groups:\t27\n") } }, "dropped_privileges");
		fails({ dropped: { ...dropped, stdout: dropped.stdout.replace("0::/agent", "0::/") } }, "dropped_privileges");
		fails({ dropped: { ...dropped, stdout: dropped.stdout.slice(1) } }, "dropped_privileges");
		expect(verificationReport(spec, "/sys/fs/cgroup/agent", 1, "Traceback").ok).toBe(false);
		expect(verificationReport(spec, "/sys/fs/cgroup/agent", 1, JSON.stringify(goodFacts())).ok).toBe(false);
	});

	test("mount points are read with their escapes", () => {
		expect(mounts("5 1 0:5 / /a\\040b rw - tmpfs tmpfs rw\n")).toEqual([{ point: "/a b", options: ["rw"], fstype: "tmpfs", superOptions: ["rw"] }]);
	});
});

describe("the image agrees with the Sandbox", () => {
	const dockerfile = read("../../container/Dockerfile");

	test("its PATH is the commands' PATH, its base is pinned, and it has no Node", () => {
		expect(dockerfile).toContain(`ENV PATH=${COMMAND_PATH} \\`);
		expect(dockerfile).toMatch(/^ARG BASE=docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]{64}$/m);
		expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--"]');
		expect(dockerfile).toContain("useradd --uid 1000 --gid 1000");
		const instructions = dockerfile.replace(/^#.*\n/gm, "").toLowerCase();
		expect(instructions).not.toMatch(/\bnode(js)?\b|\bnpm\b|corepack/);
	});

	test("its Python packages are today's, from hashed wheels only", () => {
		expect(read("../../container/python/requirements.txt")).toBe(read("../../../worker/python/requirements.txt"));
		expect(read("../../container/python/requirements.in").replace(/^#.*\n/gm, "")).toBe(read("../../../worker/python/requirements.in").replace(/^#.*\n/gm, ""));
		expect(dockerfile).toContain("--no-deps --only-binary :all: --require-hashes");
		expect(dockerfile).toContain("python3 -m compileall -q /opt/python");
	});
});

describe("fences", () => {
	test("a run or attempt older than the newest seen is older", () => {
		const state = { ...EMPTY, runId: "01900000-0000-7000-8000-000000000002", attempt: 2 };
		expect(olderThan({ runId: "01900000-0000-7000-8000-000000000002", attempt: 1 }, state)).toBe(true);
		expect(olderThan({ runId: "01900000-0000-7000-8000-000000000002", attempt: 2 }, state)).toBe(false);
		expect(olderThan({ runId: "01900000-0000-7000-8000-000000000001", attempt: 9 }, state)).toBe(true);
		expect(olderThan({ runId: "01900000-0000-7000-8000-000000000003", attempt: 1 }, state)).toBe(false);
		expect(olderThan({ runId: "01900000-0000-7000-8000-000000000001", attempt: 1 }, EMPTY)).toBe(false);
	});
});
