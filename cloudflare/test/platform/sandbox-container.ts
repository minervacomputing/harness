// A scripted stand-in for `ctx.container` in local workerd, which has no containers: it answers the
// Sandbox's root execs (readiness, hardening, verification, killing strays) as a well-hardened container
// would, and runs `echo …` through the wrapper. Enough for the lifecycle over a real object's storage; the
// real image is tested in Docker and on the account.

import type { SandboxSpec } from "../../src/sandbox/constants.ts";
import type { ContainerPort } from "../../src/sandbox/ports.ts";

function stream(text: string): ReadableStream<Uint8Array> {
	return new Blob([text]).stream();
}

function finished(stdout: string, exitCode: number): ExecProcess {
	return {
		stdin: null,
		stdout: stream(stdout),
		stderr: stream(""),
		pid: 42,
		isPty: false,
		exitCode: Promise.resolve(exitCode),
		async output() {
			return { stdout: new TextEncoder().encode(stdout).buffer as ArrayBuffer, stderr: new ArrayBuffer(0), exitCode };
		},
		kill() {},
		resize() {},
	};
}

export class ScriptedContainer implements ContainerPort {
	running = false;
	/** No image's name: its parked container retires without a snapshot, as one started from an unnamed image would. */
	readonly image = "";
	verifications = 0;
	readonly #spec: SandboxSpec;

	constructor(spec: SandboxSpec) {
		this.#spec = spec;
	}

	start(): void {
		this.running = true;
	}

	async exec(argv: string[]): Promise<ExecProcess> {
		if (!this.running) throw new Error("exec() cannot be called on a container that is not running");
		const script = argv[2] ?? "";
		if (argv[0] === "/bin/true") return finished("", 0);
		if (script.includes("step readonly_root")) return finished("step workspace\nstep tmp\nstep home_dirs\nstep cgroup\nstep readonly_root\nstep done\n", 0);
		if (argv[3] === "-c" && argv[4]?.includes("mountinfo")) {
			this.verifications++;
			const spec = this.#spec;
			const ws = Math.floor(spec.folderBytes / 4096) * 4096;
			return finished(
				JSON.stringify({
					mountinfo: [
						"1 0 0:1 / / ro,relatime - btrfs /dev/vda rw",
						`2 1 0:2 / /workspace rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=${ws / 1024}k,nr_inodes=${spec.folderEntries + 1},mode=755,uid=1000,gid=1000`,
						`3 1 0:3 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=${spec.tmpBytes / 1024}k`,
					].join("\n"),
					"/tmp": { dir: true, uid: 0, gid: 0, mode: 0o1777 },
					"/tmp/home": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
					"/tmp/matplotlib": { dir: true, uid: 1000, gid: 1000, mode: 0o755 },
					"pids.max": String(spec.pidsMax),
					"memory.max": String(spec.memoryBytes),
					tmp_exec: "EACCES",
					etc_write: "EROFS",
					dropped: {
						exit: 0,
						stdout: "\u0006Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n---\n0::/agent\n",
					},
				}),
				0,
			);
		}
		if (script.includes("cgroup.procs")) {
			const command = argv.at(-1) ?? "";
			return finished(`\u0006${command.startsWith("echo ") ? `${command.slice(5)}\n` : ""}`, 0);
		}
		return finished("", 0);
	}

	async destroy(): Promise<void> {
		this.running = false;
	}

	async setInactivityTimeout(): Promise<void> {}

	async snapshot(): Promise<never> {
		throw new Error("The scripted container takes no snapshots.");
	}
}
