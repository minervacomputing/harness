// A local stand-in for `ctx.container`: the sandbox image (cloudflare/container/) in a Docker container,
// driven through `docker exec`, so the Sandbox's logic, the wrapper, the hardening, the sandbox-shim,
// minerva-fs and the ExecutionEnv run for real in Docker tests (test/docker/sandbox-local.test.ts). It
// behaves as the platform's does where the Sandbox depends on it: exec'd processes are root unless given a
// user, session leaders with no parent, have only the environment they are given, and an aborted exec kills
// its process (exit 137).
//
// The container is privileged (the hardening mounts and remounts) and shares the Docker host's cgroup tree,
// since Docker's own cgroup cannot hold a child with controllers while its processes live in it; the agent
// cgroup is a unique one under the host's root and is removed when the container is.
//
// Node's modules come through `process.getBuiltinModule`: the unit tests are type-checked with the Worker's
// runtime types, which lack Node's.

import { type BucketPort, CHECK_MISMATCH, type ContainerPort } from "../../src/sandbox/ports.ts";

interface NodeStream {
	on(event: string, listener: (...args: unknown[]) => void): void;
}
interface NodeReadable extends NodeStream {
	pause(): void;
	resume(): void;
	destroy(): void;
}
interface Child {
	stdin: NodeStream | null;
	stdout: NodeReadable | null;
	stderr: NodeReadable | null;
	on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
}
interface Spawned {
	status: number | null;
	stdout: Uint8Array;
	stderr: Uint8Array;
}
interface NodeModules {
	getBuiltinModule(id: "node:child_process"): {
		spawn(command: string, args: string[], options: { stdio: ("pipe" | "ignore")[] }): Child;
		spawnSync(command: string, args: string[], options?: { input?: Uint8Array; timeout?: number }): Spawned;
	};
	getBuiltinModule(id: "node:stream"): {
		Writable: { toWeb(stream: NodeStream): WritableStream<Uint8Array> };
	};
	getBuiltinModule(id: "node:crypto"): { createHash(name: "sha256"): { update(data: Uint8Array): void; digest(encoding: "hex"): string } };
	env: { [name: string]: string | undefined };
}

const node = (globalThis as unknown as { process: NodeModules }).process;
const decoder = new TextDecoder();

export const LOCAL_IMAGE = node.env.MINERVA_SANDBOX_IMAGE ?? "minerva-cf-sandbox:local";

function docker(args: string[], input?: Uint8Array): Spawned {
	return node.getBuiltinModule("node:child_process").spawnSync("docker", args, { ...(input ? { input } : {}), timeout: 120_000 });
}

/**
 * A child's output as a web stream. Node's `Readable.toWeb` can enqueue a chunk after the stream is cancelled,
 * which throws from the socket's event; a cancel here destroys the output and drops what still arrives.
 */
function readable(stream: NodeReadable): ReadableStream<Uint8Array> {
	let open = true;
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				stream.on("data", (chunk) => {
					if (!open) return;
					// A plain view of Node's Buffer, as the platform's streams give.
					const bytes = chunk as Uint8Array;
					controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
					if ((controller.desiredSize ?? 1) <= 0) stream.pause();
				});
				stream.on("end", () => {
					if (open) controller.close();
					open = false;
				});
				stream.on("error", (error) => {
					if (open) controller.error(error);
					open = false;
				});
			},
			pull() {
				stream.resume();
			},
			cancel() {
				open = false;
				stream.destroy();
			},
		},
		{ highWaterMark: 16 },
	);
}

/** Whether Docker runs and has the local sandbox image (`pnpm sandbox:image` builds it). */
export function dockerReady(image = LOCAL_IMAGE): boolean {
	try {
		return docker(["image", "inspect", "--format", "{{.Id}}", image]).status === 0;
	} catch {
		return false;
	}
}

let counter = 0;

export class DockerContainer implements ContainerPort {
	readonly name: string;
	/** The agent cgroup, under the Docker host's root. */
	readonly cgroup: string;
	readonly #image: string;
	#running = false;
	#execs = 0;
	/** Set to make the next destroys fail, as a lost `destroy()` would. */
	failDestroys = 0;
	readonly started: { labels: { [name: string]: string } }[] = [];

	constructor(image = LOCAL_IMAGE) {
		const id = `${Date.now().toString(36)}${(++counter).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		this.name = `minerva-sbx-test-${id}`;
		this.cgroup = `/sys/fs/cgroup/minerva-sbx-test-${id}`;
		this.#image = image;
	}

	get running(): boolean {
		return this.#running;
	}

	start(options: { enableInternet: false; instance: "standard-1"; labels: { [name: string]: string } }): void {
		this.started.push({ labels: options.labels });
		docker(["rm", "-f", this.name]);
		const result = docker(["run", "-d", "--name", this.name, "--privileged", "--cgroupns=host", "--network", "none", this.#image]);
		if (result.status !== 0) throw new Error(`docker run failed: ${decoder.decode(result.stderr)}`);
		this.#running = true;
	}

	/** Runs a root shell command in the container directly, outside the Sandbox (test setup and checks). */
	shell(script: string, input?: Uint8Array): { status: number | null; stdout: string; stderr: string } {
		const result = docker(["exec", ...(input ? ["-i"] : []), this.name, "/bin/bash", "-c", script], input);
		return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
	}

	async exec(argv: string[], options: ContainerExecOptions): Promise<ExecProcess> {
		if (!this.#running) throw new Error("exec() cannot be called on a container that is not running");
		const { spawn } = node.getBuiltinModule("node:child_process");
		const { Writable } = node.getBuiltinModule("node:stream");
		const pidFile = `/dev/shm/minerva-exec-${++this.#execs}`;
		const stdin = options.stdin !== undefined;
		const args = ["exec", ...(stdin ? ["-i"] : []), ...(options.cwd ? ["-w", options.cwd] : []), ...(options.user ? ["-u", options.user] : [])];
		for (const [name, value] of Object.entries(options.env ?? {})) args.push("-e", `${name}=${value}`);
		args.push(this.name, "/bin/sh", "-c", `echo $$ > ${pidFile}; exec "$@"`, "sh", ...argv);
		const child = spawn("docker", args, {
			stdio: [stdin ? "pipe" : "ignore", options.stdout === "ignore" ? "ignore" : "pipe", options.stderr === "ignore" ? "ignore" : "pipe"],
		});
		const exitCode = new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) => resolve(code ?? (signal ? 137 : 1)));
		});
		const name = this.name;
		let pid: number | null = null;
		const readPid = (): number => {
			if (pid !== null) return pid;
			for (let tries = 0; tries < 50; tries++) {
				const text = decoder.decode(docker(["exec", name, "cat", pidFile]).stdout).trim();
				if (/^\d+$/.test(text)) {
					pid = Number(text);
					return pid;
				}
			}
			return -1;
		};
		const kill = (signal = 9) => {
			const target = readPid();
			if (target > 1) docker(["exec", name, "kill", `-${signal}`, String(target)]);
		};
		if (options.signal?.aborted) kill(9);
		else options.signal?.addEventListener("abort", () => kill(9), { once: true });
		let stdinStream: WritableStream | null = null;
		if (options.stdin === "pipe") stdinStream = Writable.toWeb(child.stdin as NodeStream);
		else if (options.stdin) void (options.stdin as ReadableStream).pipeTo(Writable.toWeb(child.stdin as NodeStream)).catch(() => undefined);
		const stdout = child.stdout ? readable(child.stdout) : null;
		const stderr = child.stderr ? readable(child.stderr) : null;
		const proc: ExecProcess = {
			stdin: stdinStream,
			stdout,
			stderr,
			get pid() {
				return readPid();
			},
			isPty: false,
			exitCode,
			async output() {
				const [out, errors, code] = await Promise.all([new Response(stdout).arrayBuffer(), new Response(stderr).arrayBuffer(), exitCode]);
				return { stdout: out, stderr: errors, exitCode: code };
			},
			kill,
			resize() {},
		};
		return proc;
	}

	async destroy(): Promise<void> {
		if (this.failDestroys > 0) {
			this.failDestroys--;
			throw new Error("destroy failed (injected)");
		}
		this.remove();
	}

	/** Removes the container and its agent cgroup. */
	remove(): void {
		if (this.#running || docker(["inspect", this.name]).status === 0) {
			docker([
				"exec",
				this.name,
				"/bin/bash",
				"-c",
				`[ -d ${this.cgroup} ] && { echo 1 > ${this.cgroup}/cgroup.kill; for i in $(seq 50); do rmdir ${this.cgroup} 2>/dev/null && break; sleep 0.1; done; }; true`,
			]);
			docker(["rm", "-f", this.name]);
		}
		this.#running = false;
	}

	async setInactivityTimeout(): Promise<void> {}
}

/** An in-memory bucket that, like R2, refuses a put whose bytes do not match its SHA-256 or length. */
export class MemoryBucket implements BucketPort {
	readonly objects = new Map<string, Uint8Array>();
	gets = 0;
	puts = 0;

	async get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
		this.gets++;
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return { size: bytes.length, body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() };
	}

	async put(key: string, body: ReadableStream<Uint8Array>, options: { size: number; sha256: string }): Promise<void> {
		this.puts++;
		const bytes = new Uint8Array(await new Response(body).arrayBuffer());
		if (bytes.length !== options.size) throw new Error(`put: the body has ${bytes.length} bytes, not ${options.size}`);
		if (sha256Hex(bytes) !== options.sha256) throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
		this.objects.set(key, bytes);
	}

	checks = 0;

	async check(body: ReadableStream<Uint8Array>, options: { size: number; sha256: string }): Promise<void> {
		this.checks++;
		const bytes = new Uint8Array(await new Response(body).arrayBuffer());
		if (bytes.length !== options.size) throw new Error(`check: the body has ${bytes.length} bytes, not ${options.size}`);
		if (sha256Hex(bytes) !== options.sha256) throw new Error(CHECK_MISMATCH);
	}
}

export function sha256Hex(bytes: Uint8Array): string {
	const hash = node.getBuiltinModule("node:crypto").createHash("sha256");
	hash.update(bytes);
	return hash.digest("hex");
}
