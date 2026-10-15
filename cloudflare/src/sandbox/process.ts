// Running processes in the container: root's (hardening, verification, killing strays) directly, and
// everything the agent can influence through the wrapper (wrapper.ts), whose first stdout byte says whether
// the command started.

import { ByteReader, drain } from "./bytes.ts";
import { COMMAND_PATH, HOME, TMP } from "./constants.ts";
import type { ContainerPort } from "./ports.ts";
import { type Admission, readAdmission, type WrappedCommand, wrapperArgv } from "./wrapper.ts";

/**
 * The container of one incarnation. `live` turns false once the incarnation is over, and every later exec
 * fails as if the container were gone, so work admitted for one incarnation never runs in the next.
 */
export interface Machine {
	container: ContainerPort;
	cgroup: string;
	live?(): boolean;
	/** A wrapped process the agent cgroup did not admit: the container is in doubt. */
	admissionFailed?(): Promise<void>;
	/**
	 * Resolves when a wrapped process may start (not while strays are being killed), with what to call once
	 * it is in the agent cgroup or will never be: a kill waits for every process between the two.
	 */
	gate?(): Promise<(() => void) | undefined>;
}

/** The container is gone: an exec cannot be started. */
export class ContainerGone extends Error {}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long an exec may take to answer before the container counts as gone. */
const SPAWN_MS = 60_000;
/** How long a root process killed at its deadline has to exit and end its output before the container counts as gone. */
const KILL_GRACE_MS = 5000;

/**
 * `work`, or ContainerGone after `ms`: an exec that never answers cannot hold its caller, nor the Sandbox's
 * lifecycle queue behind it. What it does if it answers later dies with the container, which the Sandbox
 * destroys on ContainerGone.
 */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ContainerGone(message)), ms);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** An exec in the incarnation's container; ContainerGone when the incarnation is over or the exec cannot start or does not answer. */
export async function spawn(machine: Machine, argv: string[], options: ContainerExecOptions): Promise<ExecProcess> {
	if (machine.live && !machine.live()) throw new ContainerGone("The incarnation is over.");
	let exec: Promise<ExecProcess> | undefined;
	try {
		exec = machine.container.exec(argv, options);
		return await within(exec, SPAWN_MS, "The container did not answer an exec.");
	} catch (error) {
		// A process that answers after this is never read: its end, with the container, raises nothing.
		void exec?.then(
			(proc) => proc.exitCode.catch(() => undefined),
			() => undefined,
		);
		if (error instanceof ContainerGone) throw error;
		throw new ContainerGone(error instanceof Error ? error.message : String(error));
	}
}

export interface RootResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Kills a process through its exec's AbortController, but only while it runs: an abort after the exit
 * raises an error in the object nothing can catch.
 */
function stopper(proc: ExecProcess, controller: AbortController): () => void {
	let exited = false;
	proc.exitCode.then(
		() => (exited = true),
		() => (exited = true),
	);
	return () => {
		if (!exited && !controller.signal.aborted) controller.abort();
	};
}

/**
 * A root process with its output collected (each stream up to `maxOutput` bytes), killed after `timeoutMs`,
 * counted from before the exec. ContainerGone when it has not ended KILL_GRACE_MS after that: an exec that
 * never answers, or a kill that ends neither the process nor its output.
 */
export async function runRoot(machine: Machine, argv: string[], options: { timeoutMs: number; maxOutput?: number }): Promise<RootResult> {
	const controller = new AbortController();
	let stop: (() => void) | null = null;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		stop?.();
	}, options.timeoutMs);
	const run = async (): Promise<RootResult> => {
		const proc = await spawn(machine, argv, { stdout: "pipe", stderr: "pipe", signal: controller.signal });
		stop = stopper(proc, controller);
		// An exec that answered after the deadline is killed, once `stopper` saw whether it already exited.
		if (timedOut) setTimeout(stop, 0);
		const max = options.maxOutput ?? 1024 * 1024;
		const [stdout, stderr, exitCode] = await Promise.all([drain(proc.stdout, max), drain(proc.stderr, max), proc.exitCode.catch(() => 137)]);
		const decoder = new TextDecoder();
		return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr), timedOut };
	};
	try {
		return await within(run(), options.timeoutMs + KILL_GRACE_MS, "The container did not end a root process.");
	} finally {
		clearTimeout(timer);
	}
}

/** A wrapped process: its stdout after the wrapper's prefix, once the prefix said whether it started. */
export interface Wrapped {
	proc: ExecProcess;
	/** Kills the process if it still runs. */
	stop(): void;
	admission: Admission;
	/** Stdout after the prefix. */
	stdout: ByteReader;
}

/** Starts `command` through the wrapper and reads its prefix. An abort of `signal` kills it, at any point. */
export async function startWrapped(
	machine: Machine,
	command: WrappedCommand,
	options: { stdin?: ReadableStream | "pipe"; stderr?: "pipe" | "ignore"; signal?: AbortSignal } = {},
): Promise<Wrapped> {
	const controller = new AbortController();
	if (options.signal?.aborted) controller.abort();
	else options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
	const argv = wrapperArgv(machine.cgroup, command);
	const admitted = await machine.gate?.();
	try {
		const proc = await spawn(machine, argv, {
			stdout: "pipe",
			stderr: options.stderr ?? "pipe",
			signal: controller.signal,
			...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		});
		const stop = stopper(proc, controller);
		const stdout = new ByteReader(proc.stdout as ReadableStream<Uint8Array>);
		let head = new Uint8Array(0);
		for (;;) {
			const read = readAdmission(head, false);
			if (read) {
				stdout.unshift(read.rest);
				if (!read.admission.started && read.admission.reason === "admission") await machine.admissionFailed?.();
				return { proc, stop, admission: read.admission, stdout };
			}
			const more = await stdout.some().catch(() => null);
			if (more === null) {
				const ended = readAdmission(head, true) as { admission: Admission; rest: Uint8Array };
				stdout.unshift(ended.rest);
				if (!ended.admission.started && ended.admission.reason === "admission") await machine.admissionFailed?.();
				return { proc, stop, admission: ended.admission, stdout };
			}
			const joined = new Uint8Array(head.length + more.length);
			joined.set(head, 0);
			joined.set(more, head.length);
			head = joined;
		}
	} finally {
		// Its prefix came (it wrote its byte from inside the cgroup), or it ended, or it never started.
		admitted?.();
	}
}

/** The environment of the commands the Sandbox runs itself (file operations, the folder's tar and find): nothing else. */
export function helperEnvironment(): { [name: string]: string } {
	return { PATH: COMMAND_PATH, HOME, TMPDIR: TMP, LANG: "C.UTF-8" };
}

/** Kills a process group, as root: the wrapped command's pid leads it, so every process it did not move out of it dies. */
export async function killGroup(machine: Machine, pid: number): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid <= 1) return;
	await runRoot(machine, ["/bin/bash", "-c", 'kill -KILL -- "-$0" 2>/dev/null; kill -KILL -- "$0" 2>/dev/null; exit 0', String(pid)], { timeoutMs: 10_000 }).catch(() => undefined);
}
