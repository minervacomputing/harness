// An agent command (`ExecRequest`): run through the wrapper, both streams read as they
// arrive and handed to the caller's sink through an OutputPump, the complete output spilled to a file in
// the container past pi's thresholds, then the outcome in pi's terms (pi's NodeExecutionEnv.exec): after
// the process exits, output is still taken until both streams end or 100 ms pass without any, so a
// background process holding a pipe cannot hold the call.

import type { ExecutionErrorCode, ShellOutputSkip } from "@earendil-works/pi-durable/env";
import { parseJson } from "../lib/json.ts";
import { ByteReader } from "./bytes.ts";
import { KILL_AFTER_SECONDS, TMP } from "./constants.ts";
import { OutputPump, SpillCounter, type Stream, StreamText } from "./output.ts";
import { ContainerGone, helper, killGroup, type Machine, sleep, startWrapped, type Wrapped } from "./process.ts";

export interface ExecRequest {
	/** Chosen by the caller, unique within the incarnation; `cancel` names it. */
	execId: string;
	/** A string runs through `bash -c`; an array runs without a shell, arguments unparsed. */
	command: string | string[];
	cwd: string;
	/**
	 * Exactly the command's environment; nothing is inherited. Bash calls get PATH, HOME=/tmp/home,
	 * TMPDIR=/tmp, LANG=C.UTF-8 and MPLCONFIGDIR=/tmp/matplotlib.
	 */
	env: { [name: string]: string };
	/**
	 * Seconds, already cut to the run's deadline; 0 for none. The wrapper's `timeout` stops the command's
	 * process group (TERM, then KILL 5 s later) and the result is `timeout`.
	 */
	timeoutSeconds: number;
	/** Spill the complete output to a file under /tmp past either threshold (pi's ShellSpillOptions). */
	spill?: { afterBytes: number; afterLines: number };
	/** The tail the caller keeps; output outside it may be skipped and reported (pi's ShellOutputWindow). */
	window?: { maxBytes: number; maxLines: number; minIntervalMs: number; bytesPerSecond: number };
}

/** An RpcTarget the caller passes to `exec`, called with output as it arrives, each stream decoded separately. */
export interface ExecOutputSink {
	output(chunk: { stream: "stdout" | "stderr"; text: string; skipped?: ShellOutputSkip }): void;
}

export type ExecResult =
	| { ok: true; exitCode: number; spillPath?: string }
	| { ok: false; code: ExecutionErrorCode; message: string; spillPath?: string };

/** pi's EXIT_STDIO_GRACE_MS. */
const STDIO_GRACE_MS = 100;
/**
 * However much output keeps coming after the exit (a detached process holding the pipe), the call ends this
 * long after it: pi would wait for 100 ms of quiet forever.
 */
const AFTER_EXIT_MS = 10_000;
/** A spill write the spill helper does not take within this long fails the spill. */
const SPILL_WRITE_MS = 30_000;
/** After `timeout`'s KILL, how long the Sandbox waits before it kills the group itself. */
const BACKSTOP_MS = 10_000;

export interface RunningCommand {
	pid: number | null;
	/** The caller cancelled it: the outcome is `aborted`. */
	cancelled: boolean;
	cancel(): void;
}

export interface CommandHooks {
	/** Called once the process exists, so `cancel` can reach it. */
	started(command: RunningCommand): void;
	now(): number;
}

class Spill {
	path: string | null = null;
	error: string | null = null;
	readonly #counter: SpillCounter;
	readonly #prefix: Uint8Array[] = [];
	#writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	#process: Wrapped | null = null;
	readonly #machine: Machine;

	constructor(machine: Machine, options: NonNullable<ExecRequest["spill"]>) {
		this.#machine = machine;
		this.#counter = new SpillCounter(options);
	}

	async take(chunk: Uint8Array): Promise<void> {
		if (this.error !== null) return;
		if (this.#writer) {
			await this.#write(chunk);
			return;
		}
		if (!this.#counter.passed(chunk)) {
			this.#prefix.push(chunk);
			return;
		}
		try {
			this.path = await makeTemp(this.#machine, "file", "pi-output-", ".log");
			this.#process = await startWrapped(this.#machine, helper("spill", [this.path], 0), { stdin: "pipe" });
			if (!this.#process.admission.started) throw new Error("The spill file could not be written.");
			this.#writer = (this.#process.proc.stdin as WritableStream<Uint8Array>).getWriter();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return;
		}
		for (const part of this.#prefix.splice(0)) await this.#write(part);
		await this.#write(chunk);
	}

	async #write(chunk: Uint8Array): Promise<void> {
		if (this.error !== null) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#writer?.write(chunk),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("The spill file stopped taking output.")), SPILL_WRITE_MS);
				}),
			]);
		} catch (error) {
			this.error ??= error instanceof Error ? error.message : String(error);
			this.#process?.stop();
		} finally {
			clearTimeout(timer);
		}
	}

	async finish(): Promise<void> {
		if (!this.#writer || !this.#process) return;
		if (this.error !== null) {
			this.#process.stop();
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const writer = this.#writer;
		const helperProcess = this.#process;
		try {
			// The deadline covers closing the helper's input too: a stopped helper takes neither.
			const line = await Promise.race([
				(async () => {
					await writer.close();
					return await helperProcess.stdout.line(64 * 1024);
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("The spill file was not finished.")), SPILL_WRITE_MS);
				}),
			]);
			const answer = line && (parseJson(new TextDecoder().decode(line)) as { ok?: unknown; message?: unknown });
			if (!answer || answer.ok !== true) this.error ??= typeof answer?.message === "string" ? answer.message : "The spill file could not be written.";
		} catch (error) {
			this.error ??= error instanceof Error ? error.message : String(error);
			this.#process.stop();
		} finally {
			clearTimeout(timer);
		}
	}

	abort(): void {
		this.#process?.stop();
	}
}

/** A temporary file or directory under /tmp, made by the agent's user (pi's createTempFile and createTempDir). */
export async function makeTemp(machine: Machine, kind: "file" | "dir", prefix: string, suffix: string): Promise<string> {
	const wrapped = await startWrapped(machine, helper("mktemp", [kind, prefix, suffix]));
	if (!wrapped.admission.started) throw new Error("A temporary file could not be made.");
	const line = await wrapped.stdout.line(64 * 1024);
	await wrapped.proc.exitCode.catch(() => undefined);
	const answer = line && (parseJson(new TextDecoder().decode(line)) as { ok?: unknown; value?: unknown; message?: unknown });
	if (!answer || answer.ok !== true || typeof answer.value !== "string" || !answer.value.startsWith(`${TMP}/`)) {
		throw new Error(typeof answer?.message === "string" ? answer.message : "A temporary file could not be made.");
	}
	return answer.value;
}

export async function runCommand(machine: Machine, request: ExecRequest, sink: ExecOutputSink | null, hooks: CommandHooks): Promise<ExecResult> {
	const command = request.command;
	if (typeof command !== "string" && command.length === 0) return { ok: false, code: "spawn_error", message: "Empty argv: no program to run" };
	let wrapped: Wrapped;
	const started = hooks.now();
	try {
		wrapped = await startWrapped(machine, { command, cwd: request.cwd, env: request.env, timeoutSeconds: request.timeoutSeconds });
	} catch (error) {
		if (error instanceof ContainerGone) throw error;
		return { ok: false, code: "spawn_error", message: error instanceof Error ? error.message : String(error) };
	}
	let killed = false;
	const kill = () => {
		if (killed) return;
		killed = true;
		void killGroup(machine, wrapped.proc.pid);
		wrapped.stop();
	};
	const running: RunningCommand = {
		pid: wrapped.proc.pid,
		cancelled: false,
		cancel() {
			running.cancelled = true;
			kill();
		},
	};
	hooks.started(running);
	const stderr = new ByteReader(wrapped.proc.stderr as ReadableStream<Uint8Array>);
	if (!wrapped.admission.started) {
		const exitCode = await wrapped.proc.exitCode.catch(() => -1);
		await Promise.all([wrapped.stdout.cancel(), stderr.cancel()]);
		if (wrapped.admission.reason === "cwd") {
			return { ok: false, code: "spawn_error", message: `Working directory does not exist: ${request.cwd}\nCannot execute bash commands.` };
		}
		if (wrapped.admission.reason === "missing") return { ok: false, code: "spawn_error", message: `spawn ${String(command[0])} ENOENT` };
		if (wrapped.admission.reason === "denied") return { ok: false, code: "spawn_error", message: `spawn ${String(command[0])} EACCES` };
		return { ok: false, code: "spawn_error", message: `The sandbox could not admit the command (exit ${exitCode}).` };
	}

	const pump = new OutputPump({
		...(request.window ? { window: request.window } : {}),
		deliver: async (chunk) => {
			await sink?.output(chunk);
		},
		now: hooks.now,
		sleep,
	});
	const spill = request.spill ? new Spill(machine, request.spill) : null;
	const decoders: Record<Stream, StreamText> = { stdout: new StreamText(), stderr: new StreamText() };
	let chain: Promise<void> = Promise.resolve();
	let lastData = hooks.now();
	// Chunks taken and not yet handed on: while one waits for the caller, the streams are not quiet, and the
	// time after the exit does not count against AFTER_EXIT_MS, so a slow caller loses nothing.
	let busy = 0;
	let waited = 0;
	let busySince = 0;
	const take = (stream: Stream, chunk: Uint8Array): Promise<void> => {
		lastData = hooks.now();
		if (busy++ === 0) busySince = hooks.now();
		chain = chain.then(async () => {
			try {
				pump.push(stream, decoders[stream].decode(chunk));
				// Without a window, a producer faster than the caller waits here, and so do its pipes.
				await pump.room();
				if (spill) {
					await spill.take(chunk);
					if (spill.error !== null) kill();
				}
			} finally {
				if (--busy === 0) waited += hooks.now() - busySince;
				lastData = hooks.now();
			}
		});
		return chain;
	};
	const ended: Record<Stream, boolean> = { stdout: false, stderr: false };
	const read = async (stream: Stream, reader: ByteReader) => {
		try {
			for (;;) {
				const chunk = await reader.some();
				if (chunk === null) break;
				await take(stream, chunk);
			}
		} catch {
			// A stream the container ended abruptly, or one cancelled below: what was read stands.
		}
		ended[stream] = true;
	};
	const reading = Promise.all([read("stdout", wrapped.stdout), read("stderr", stderr)]);

	let backstop: ReturnType<typeof setTimeout> | undefined;
	if (request.timeoutSeconds > 0) {
		backstop = setTimeout(() => void killGroup(machine, wrapped.proc.pid), (request.timeoutSeconds + KILL_AFTER_SECONDS) * 1000 + BACKSTOP_MS);
	}
	let exitCode: number;
	try {
		exitCode = await wrapped.proc.exitCode;
	} catch {
		exitCode = 137;
	} finally {
		clearTimeout(backstop);
	}
	const elapsed = hooks.now() - started;
	const exitedAt = hooks.now();
	const waitedAtExit = waited + (busy > 0 ? hooks.now() - busySince : 0);
	/** Time since the exit spent reading, not waiting for the caller. */
	const afterExit = () => hooks.now() - exitedAt - (waited + (busy > 0 ? hooks.now() - busySince : 0) - waitedAtExit);
	// Output still arriving after the exit is taken until both streams end or go quiet (pi's grace), and
	// never for longer than AFTER_EXIT_MS.
	for (;;) {
		if (ended.stdout && ended.stderr) break;
		if (busy > 0) lastData = hooks.now();
		const quiet = hooks.now() - lastData;
		if (quiet >= STDIO_GRACE_MS || afterExit() >= AFTER_EXIT_MS) break;
		await Promise.race([reading, sleep(Math.min(STDIO_GRACE_MS - quiet, AFTER_EXIT_MS))]);
	}
	await Promise.all([wrapped.stdout.cancel(), stderr.cancel()]);
	await reading;
	await chain;
	pump.push("stdout", decoders.stdout.decode());
	pump.push("stderr", decoders.stderr.decode());
	await pump.flush();
	await spill?.finish();
	const spillPath = spill?.path ?? undefined;
	const withSpill = spillPath === undefined ? {} : { spillPath };

	if (running.cancelled) return { ok: false, code: "aborted", message: "aborted", ...withSpill };
	const timedOut = request.timeoutSeconds > 0 && elapsed >= request.timeoutSeconds * 1000 - 50 && (exitCode === 124 || exitCode === 137);
	if (timedOut) return { ok: false, code: "timeout", message: `timeout:${request.timeoutSeconds}`, ...withSpill };
	if (spill?.error != null) {
		spill.abort();
		return { ok: false, code: "unknown", message: `Failed to preserve complete shell output: ${spill.error}` };
	}
	return { ok: true, exitCode, ...withSpill };
}
