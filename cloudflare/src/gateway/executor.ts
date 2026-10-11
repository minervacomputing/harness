// The permission executor, ported from backend/connectors/executor.py and the call wrapper of
// backend/gateway/mcp.py (connectors 7, runs 5.3): every connector tool call of a run goes through this
// one pipeline, in today's order (contracts/executor.ts `Executor`):
//
// count the call and take a slot → current attempt → tool lookup and contract → strict validation →
// query hash → page token → write key and known write → open the client (a credential lease fenced by
// run and attempt) → consent → prepare → authorize (declaration, then policy) → current attempt → execute,
// or dispatch, execute and settle the write → still active → close the client → run-bound page token.
//
// It runs in the Conversation Durable Object, so every run-state check is a synchronous read
// (RunStatePort): the revocation check before each provider request happens in the same tick as the
// request starts (the call's CallIo checks it right before each fetch; plan: Strict revocation).
//
// Cancelling a call (its signal, from pi's abort) answers the caller at once and starts nothing more: no
// later step, and no new provider request. A write already dispatched still settles with its real
// outcome, under the host's `waitUntil` (plan: Writes), bounded by its request's timeout and the
// backstop; today the cancelled task cancelled its request too and the write became uncertain.

import type { z } from "zod";
import type { EpochMs, RunId } from "../contracts/common.ts";
import type { Connector, CredentialPayload, Operation, Prepared, ProviderOutput, Requirement } from "../contracts/connectors.ts";
import type {
	CredentialLease,
	CredentialPort,
	Executor,
	ExecutorContext,
	RunStatePort,
	ToolCallOutcome,
	ToolCallRequest,
	ToolDeclaration,
	ToolResult,
} from "../contracts/executor.ts";
import type { Resource } from "../contracts/policy.ts";
import type { ToolRef } from "../contracts/runs.ts";
import { type Clock, systemClock } from "./clock.ts";
import { ACCOUNT_KIND, OperationError, type OperationTerms, binding, consentGiven, denied, kindOf, nests, requiresOf, termsOf } from "./connector.ts";
import { CallIo } from "./http.ts";
import { RUN_ENDED_MESSAGE, WRITE_MESSAGES, knownAnswer, writeKey } from "./ledger.ts";
import { INVALID_CURSOR_MESSAGE, LIMIT_REACHED_MESSAGE, queryHash } from "./page-tokens.ts";
import { ANY, Policy } from "./policy.ts";
import { type Registry, inputSchema } from "./registry.ts";
import { RESULT_SCHEMA, type ShownCall, allowedEvent, appliedWithoutResult, publicError, refusedEvent, shownCall, writeId } from "./results.ts";
import { validateInput } from "./validation.ts";

/** The provider client enforces the write's deadline; this only stops a connector that ignores it. */
export const BACKSTOP_MS = 5000;
/** `run_tool_concurrency`: calls of one run that execute at once. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_ANCESTORS = 64;
export const CONNECTOR_ERROR_MESSAGE = "This operation failed because of an internal error.";

export interface ExecutorLog {
	error(message: string, ...data: unknown[]): void;
	warn(message: string, ...data: unknown[]): void;
}

/** What the host gives the executor besides the run: the object's registry, secret, clocks and lifetime. */
export interface ExecutorHost {
	registry: Registry;
	/** MINERVA_SECRET_KEY, which keys the write ids events carry. */
	secretKey: string;
	/**
	 * Keeps a write's settle alive when the call that asked for it is cancelled or abandoned: the
	 * Conversation Durable Object passes `ctx.waitUntil`, or its own tracker that stops wait for.
	 */
	waitUntil(promise: Promise<unknown>): void;
	clock?: Clock;
	log?: ExecutorLog;
	/** Default 4. */
	concurrency?: number;
}

function ended(): OperationError {
	return new OperationError("RUN_ENDED", RUN_ENDED_MESSAGE);
}

/** Python's truthiness, for `if op.paginated and fields.get("cursor")`. */
function truthy(value: unknown): boolean {
	if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/** The secret a connector's client is built with: the OAuth access token, the API key, or "" for a built-in service. */
function secretOf(payload: CredentialPayload): string {
	if (payload.kind === "api_key") return payload.key;
	if (payload.kind === "builtin") return "";
	// OAuth, and legacy rows without a kind, which are read as OAuth.
	return payload.access_token;
}

/** Whether a CONNECTION_UNAUTHORIZED is anywhere in the error's cause chain (credentials.py `_unauthorized`). */
function unauthorized(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== null && current !== undefined && !seen.has(current)) {
		seen.add(current);
		if (current instanceof OperationError && current.code === "CONNECTION_UNAUTHORIZED") return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

function describe(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isRequirement(value: unknown, field: "need" | "enumerate"): boolean {
	return typeof value === "object" && value !== null && field in value && typeof (value as { action?: unknown }).action === "string";
}

/** Why a resource from a connector is malformed, or null (executor.py `_shape_problem`). */
function shapeProblem(connector: Connector, resource: Resource): string | null {
	if (typeof resource !== "object" || resource === null || typeof resource.id !== "string" || !Array.isArray(resource.within) || typeof resource.partial !== "boolean") {
		return "not a resource";
	}
	if (!nests(connector, resource.kind)) return resource.within.length > 0 || resource.partial ? "ancestors on a kind that does not nest" : null;
	const ids = [resource.id, ...resource.within];
	if (resource.within.length > MAX_ANCESTORS || ids.includes(ANY) || new Set(ids).size !== ids.length) return "malformed ancestors";
	return null;
}

/**
 * The records the run may see (executor.py `_result`; connectors 7.4). A record on another connection, of a
 * kind the operation does not need, malformed, or of a kind without the output action (even under an
 * unrestricted policy, which would pass any action) is a connector bug: logged and dropped. `count` is
 * what is left, so a page can be empty while the provider had records.
 */
export function visibleResult(
	connector: Connector,
	op: Operation<never>,
	ref: Pick<ToolRef, "connection_id" | "provider">,
	policy: Policy,
	output: ProviderOutput,
	log: ExecutorLog = console,
): ToolResult {
	const terms = termsOf(op);
	const kinds = new Set(op.needs.map(([kind]) => kind));
	const requires = requiresOf(connector);
	const items: ToolResult["items"] = [];
	for (const record of output.records) {
		const resource = record?.resource;
		if (
			shapeProblem(connector, resource) !== null ||
			resource.connectionId !== ref.connection_id ||
			!kinds.has(resource.kind) ||
			resource.id === ANY ||
			!(kindOf(connector, resource.kind)?.actions.includes(terms.outputAction) ?? false)
		) {
			log.error(`Connector ${ref.provider}.${op.name} returned a record with ${describe(resource)}`);
			continue;
		}
		if (policy.permits(resource, terms.outputAction, requires)) items.push(record.data);
	}
	const result: ToolResult = { items, count: items.length };
	if (output.incomplete) result.incomplete = true;
	return result;
}

/** Rejects with the signal's reason once it aborts; `promise`'s own later rejection is not left unhandled. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	promise.catch(() => {});
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/** A per-run semaphore (mcp.py `_slot`): waits no longer than the run's deadline, else RUN_ENDED. */
class Slots {
	#free: number;
	readonly #waiting: (() => void)[] = [];

	constructor(size: number) {
		this.#free = size;
	}

	acquire(deadline: EpochMs | null, clock: Clock, signal: AbortSignal | undefined): Promise<void> {
		if (this.#free > 0) {
			this.#free--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = null;
			const give = () => {
				if (timer !== null) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const leave = (reason: unknown) => {
				const at = this.#waiting.indexOf(give);
				if (at >= 0) this.#waiting.splice(at, 1);
				if (timer !== null) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(reason);
			};
			const abort = () => leave(signal?.reason);
			this.#waiting.push(give);
			if (deadline !== null) timer = setTimeout(() => leave(ended()), Math.max(0, deadline - clock.now()));
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	release(): void {
		const next = this.#waiting.shift();
		if (next === undefined) this.#free++;
		else next();
	}
}

interface Done {
	result: ToolResult;
	title: string;
	repeat: boolean;
	writeKey: string | null;
}

/** The executor of one run: `invoke` for each tool call, `declarations` for the model's tool list. */
export class ToolExecutor implements Executor {
	readonly #runId: RunId;
	readonly #run: RunStatePort;
	readonly #credentials: CredentialPort;
	readonly #fetch: typeof fetch;
	readonly #tools: readonly ToolRef[];
	readonly #refs: ReadonlyMap<string, ToolRef>;
	readonly #policy: Policy;
	readonly #deadline: EpochMs | null;
	readonly #registry: Registry;
	readonly #host: ExecutorHost;
	readonly #clock: Clock;
	readonly #log: ExecutorLog;
	readonly #slots: Slots;
	readonly #pending = new Set<Promise<void>>();

	constructor(context: ExecutorContext, host: ExecutorHost) {
		this.#runId = context.runId;
		this.#run = context.run;
		this.#credentials = context.credentials;
		this.#fetch = context.fetch;
		this.#tools = [...context.tools];
		this.#refs = new Map(context.tools.map((ref) => [ref.name, ref]));
		// Throws on a malformed snapshot, so a run whose policy cannot be read never calls a tool.
		this.#policy = Policy.fromJson(context.permissions);
		this.#deadline = context.deadline ?? null;
		this.#registry = host.registry;
		this.#host = host;
		this.#clock = host.clock ?? systemClock;
		this.#log = host.log ?? console;
		this.#slots = new Slots(host.concurrency ?? DEFAULT_CONCURRENCY);
	}

	/** The tools whose contract still resolves, as the model sees them (mcp.py `list_tools`). */
	declarations(): ToolDeclaration[] {
		const out: ToolDeclaration[] = [];
		for (const ref of this.#tools) {
			const op = this.#registry.resolve(ref.provider, ref.operation, ref.contract);
			if (op === null) continue;
			out.push({
				name: ref.name,
				title: op.title,
				description: op.description,
				inputSchema: inputSchema(op),
				outputSchema: RESULT_SCHEMA,
				annotations: { readOnlyHint: !termsOf(op).mutates },
			});
		}
		return out;
	}

	/** Resolves once every write this executor dispatched has settled. */
	async settled(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all([...this.#pending]);
	}

	async invoke(request: ToolCallRequest): Promise<ToolCallOutcome> {
		request.signal?.throwIfAborted();
		const shown = shownCall(this.#registry, this.#refs, request.name, request.arguments);
		const outcome = this.#call(request).then(
			(done) => this.#allowed(shown, done),
			(error: unknown) => this.#refused(shown, request, error),
		);
		// Registered first, so it runs before the caller hears the outcome.
		if (request.settled) {
			const settled = request.settled;
			void outcome.then(
				(answer) => {
					try {
						settled(answer);
					} catch (error) {
						this.#log.error(`Recording tool ${request.name} failed for run ${this.#runId}`, error);
					}
				},
				() => {},
			);
		}
		return unlessAborted(outcome, request.signal);
	}

	async #allowed(shown: ShownCall, done: Done): Promise<ToolCallOutcome> {
		const write = done.writeKey === null ? null : await writeId(this.#host.secretKey, this.#runId, done.writeKey);
		// Checked again right before the result is returned (plan: Strict revocation), as the client's close
		// was awaited since the last check; a write already settled stays recorded.
		if (!this.#run.isActive(this.#runId)) return { ok: false, error: { code: "RUN_ENDED", message: RUN_ENDED_MESSAGE }, event: null };
		// Recorded for a call a replaced attempt started too: what it did is still part of the run.
		const event = allowedEvent(shown, done.title, done.result.count, write, done.repeat);
		return { ok: true, result: done.result, title: done.title, repeat: done.repeat, writeKey: done.writeKey, event };
	}

	#refused(shown: ShownCall, request: ToolCallRequest, error: unknown): ToolCallOutcome {
		const { code, message } = publicError(error);
		if (!(error instanceof OperationError) && !request.signal?.aborted) this.#log.error(`Tool ${request.name} failed for run ${this.#runId}`, error);
		// A call refused because the run ended, or its attempt was replaced, is not shown.
		const event = code === "RUN_ENDED" || !this.#run.isActive(this.#runId) ? null : refusedEvent(shown, code, message);
		return { ok: false, error: { code, message }, event };
	}

	/** Counts the call, then waits for a slot (mcp.py `call_tool`): calls are counted, never limited. */
	async #call(request: ToolCallRequest): Promise<Done> {
		if (request.fence.runId !== this.#runId || !this.#run.countToolCall(request.fence)) throw ended();
		await this.#slots.acquire(this.#deadline, this.#clock, request.signal);
		try {
			// A call that waited past a revocation does nothing: the first step below refuses it.
			return await this.#pipeline(request);
		} finally {
			this.#slots.release();
		}
	}

	#ensureCurrent(request: ToolCallRequest): void {
		if (!this.#run.isCurrent(request.fence)) throw ended();
	}

	/** After work finished: the run can still act. A replaced attempt still gets its answer, so its write is recorded. */
	#ensureActive(): void {
		if (!this.#run.isActive(this.#runId)) throw ended();
	}

	/** After an await: a cancelled call goes no further. */
	#step(request: ToolCallRequest): void {
		request.signal?.throwIfAborted();
	}

	#operationFor(name: string): [ToolRef, Operation<never>] {
		const ref = this.#refs.get(name);
		if (ref === undefined) throw new OperationError("UNKNOWN_OPERATION", "This operation is not available.");
		const op = this.#registry.resolve(ref.provider, ref.operation, ref.contract);
		if (op === null) throw new OperationError("OPERATION_CHANGED", "This operation changed after the run started. Send a new message to use it.");
		return [ref, op];
	}

	async #pipeline(request: ToolCallRequest): Promise<Done> {
		this.#ensureCurrent(request);
		const [ref, op] = this.#operationFor(request.name);
		const terms = termsOf(op);
		const validated = await validateInput(op.input as z.ZodType, request.arguments);
		this.#step(request);
		if (!validated.ok) throw new OperationError("INVALID_ARGUMENTS", validated.message);
		const fields = validated.data;
		const hash = await queryHash(fields);
		this.#step(request);
		let data: { [key: string]: unknown } = fields;
		if (terms.paginated && truthy(fields.cursor)) {
			const upstream = this.#run.resolvePageToken(this.#runId, String(fields.cursor), request.name, hash);
			if (upstream === null) throw new OperationError("INVALID_CURSOR", INVALID_CURSOR_MESSAGE);
			data = { ...fields, cursor: upstream };
		}
		// The full fields, so for a paginated write the page token too (connectors 7.1 step 6).
		const key = terms.mutates ? await writeKey(request.name, fields) : null;
		this.#step(request);
		if (key !== null) {
			// Before anything else is done: a repeat skips consent, prepare, policy and the provider (risk 1).
			const known = this.#run.knownWrite(this.#runId, key);
			if (known !== null) {
				const answer = knownAnswer(known);
				if (answer.kind === "refused") throw new OperationError(answer.code, answer.message);
				return { result: answer.result, title: op.title, repeat: true, writeKey: key };
			}
		}
		const [result, repeat] = await this.#perform(request, ref, op, terms, data, hash, key);
		return { result, title: op.title, repeat, writeKey: key };
	}

	/** A lease for the call's attempt, checked before it is asked for and after it is given (plan: Fencing). */
	async #lease(request: ToolCallRequest, connectionId: string): Promise<CredentialLease> {
		this.#ensureCurrent(request);
		const lease = await this.#credentials.lease(request.fence, connectionId);
		this.#step(request);
		if ("refused" in lease) throw new OperationError(lease.refused, lease.message);
		this.#ensureCurrent(request);
		return lease;
	}

	async #perform(
		request: ToolCallRequest,
		ref: ToolRef,
		op: Operation<never>,
		terms: OperationTerms,
		data: { [key: string]: unknown },
		hash: string,
		key: string | null,
	): Promise<[ToolResult, boolean]> {
		const connector = this.#registry.get(ref.provider);
		const lease = await this.#lease(request, ref.connection_id);
		const payload = await this.#credentials.open(lease);
		this.#step(request);
		const io = new CallIo({
			fetch: this.#fetch,
			now: () => this.#clock.monotonic(),
			admits: () => !request.signal?.aborted && this.#run.isCurrent(request.fence),
		});
		const client = connector.client(secretOf(payload), io);
		// A cancelled call stops its requests in flight, except the one carrying its write: that one goes on,
		// so its outcome is recorded. New requests are refused either way (`admits`).
		const cancel = () => {
			if (io.currentWrite()?.sent !== true) io.abort();
		};
		request.signal?.addEventListener("abort", cancel, { once: true });
		let output: ProviderOutput | null = null;
		let result: ToolResult;
		let repeat = false;
		try {
			// Before prepare, so nothing is sent to the provider.
			if (!consentGiven(terms.consent, lease.scopes)) {
				throw new OperationError("CONSENT_REQUIRED", `${connector.name} has not given Minerva access for this yet. The user can allow it on Minerva's connections page.`);
			}
			const prepared = await unlessAborted(op.prepare(binding(ref.connection_id, client), data as never), request.signal);
			if (!Array.isArray(prepared?.requirements) || prepared.requirements.length === 0) throw this.#bug(`${ref.provider}.${op.name}`, "no requirements");
			this.#authorize(connector, op, terms, ref, prepared.requirements);
			this.#ensureCurrent(request);
			if (key === null) {
				output = await unlessAborted(prepared.execute(), request.signal);
				result = this.#result(connector, op, terms, ref, output);
			} else {
				[result, repeat] = await this.#write(request, connector, op, terms, ref, key, prepared, io);
			}
			this.#ensureActive();
		} catch (error) {
			if (unauthorized(error)) await this.#markUnauthorized(ref.connection_id, lease.generation);
			throw error;
		} finally {
			request.signal?.removeEventListener("abort", cancel);
			io.close();
			await client.close();
		}
		if (output !== null && output.nextCursor && terms.paginated) {
			// After the provider call: the model sees the limit, not the page.
			// Stored as text, as the CharField stored whatever cursor a connector returned.
			const token = this.#run.issuePageToken(this.#runId, request.name, hash, String(output.nextCursor));
			if (token === null) throw new OperationError("LIMIT_REACHED", LIMIT_REACHED_MESSAGE);
			result = { ...result, next_cursor: token };
		}
		return [result, repeat];
	}

	/** A token the provider rejected marks the connection Needs reconnecting, unless it got new credentials meanwhile. */
	async #markUnauthorized(connectionId: string, generation: number): Promise<void> {
		try {
			await this.#credentials.markUnauthorized(connectionId, generation);
		} catch (error) {
			this.#log.error(`Could not mark connection ${connectionId} as needing reconnecting`, error);
		}
	}

	#bug(where: string, problem: string): OperationError {
		this.#log.error(`Connector contract violation in ${where}: ${problem}`);
		return new OperationError("CONNECTOR_ERROR", CONNECTOR_ERROR_MESSAGE);
	}

	/**
	 * Checks what prepare() says the call touches against the declaration, then against the policy
	 * (connectors 7.2). A connector bug throws at once; denial is decided after the loop (risk 15).
	 */
	#authorize(connector: Connector, op: Operation<never>, terms: OperationTerms, ref: ToolRef, requirements: readonly Requirement[]): void {
		const where = `${ref.provider}.${op.name}`;
		const pairKey = (kind: string, action: string) => JSON.stringify([kind, action]);
		const declared = new Set(op.needs.map(([kind, action]) => pairKey(kind, action)));
		const covered = new Set<string>();
		const requires = requiresOf(connector);
		let concrete = false;
		let refused = false;
		for (const requirement of requirements) {
			let pair: string;
			let allowed: boolean;
			if (isRequirement(requirement, "need")) {
				const { need: resource, action } = requirement as { need: Resource; action: string };
				if (
					shapeProblem(connector, resource) !== null ||
					resource.connectionId !== ref.connection_id ||
					resource.id === ANY ||
					(resource.kind === ACCOUNT_KIND && resource.id !== ref.connection_id)
				) {
					throw this.#bug(where, `invalid resource ${describe(resource)}`);
				}
				pair = pairKey(resource.kind, action);
				concrete = true;
				allowed = this.#policy.permits(resource, action, requires);
			} else if (isRequirement(requirement, "enumerate")) {
				const { enumerate: kind, action } = requirement as { enumerate: string; action: string };
				pair = pairKey(kind, action);
				if (terms.mutates) throw this.#bug(where, "a write cannot enumerate");
				allowed = this.#policy.permitsAny(ref.connection_id, kind, action, requires, nests(connector, kind));
			} else {
				throw this.#bug(where, `unknown requirement ${describe(requirement)}`);
			}
			if (!declared.has(pair)) throw this.#bug(where, `undeclared need ${pair}`);
			covered.add(pair);
			refused = refused || !allowed;
		}
		if (covered.size !== declared.size) throw this.#bug(where, `needs not covered: ${[...declared].filter((pair) => !covered.has(pair)).join(", ")}`);
		if (terms.mutates && !concrete) throw this.#bug(where, "a write needs a concrete destination");
		if (refused) throw denied();
	}

	#result(connector: Connector, op: Operation<never>, _terms: OperationTerms, ref: ToolRef, output: ProviderOutput): ToolResult {
		return visibleResult(connector, op, ref, this.#policy, output, this.#log);
	}

	/** The write's result, and whether an identical earlier write answered it (executor.py `_write`). */
	async #write(
		request: ToolCallRequest,
		connector: Connector,
		op: Operation<never>,
		terms: OperationTerms,
		ref: ToolRef,
		key: string,
		prepared: Prepared,
		io: CallIo,
	): Promise<[ToolResult, boolean]> {
		// The port may wait before it claims (contracts/executor.ts RunStatePort); nothing is sent before it answers.
		const dispatch = await this.#run.dispatchWrite(request.fence, key);
		if (dispatch.kind === "cached") return [dispatch.result, true];
		if (dispatch.kind === "refused") throw new OperationError(dispatch.code, dispatch.message);
		if (request.signal?.aborted || !this.#run.isCurrent(request.fence)) {
			await this.#run.settleWrite(this.#runId, key, { effect: "not_applied" });
			throw ended();
		}
		const carried = this.#carryOut(connector, op, terms, ref, key, prepared, io, dispatch.deadline);
		this.#keepAlive(carried);
		return carried;
	}

	/**
	 * Executes a dispatched write and settles it by what the client recorded, not by what the connector
	 * returned: a normal return proves nothing (the connector may have swallowed a failure, or left the
	 * request running). Always settled, whichever attempt is current by then (plan: Fencing).
	 */
	async #carryOut(
		connector: Connector,
		op: Operation<never>,
		terms: OperationTerms,
		ref: ToolRef,
		key: string,
		prepared: Prepared,
		io: CallIo,
		deadline: number,
	): Promise<[ToolResult, boolean]> {
		const settle = async (settlement: Parameters<RunStatePort["settleWrite"]>[2]) => this.#run.settleWrite(this.#runId, key, settlement);
		const attempt = io.openWrite(deadline);
		try {
			let result: ToolResult;
			try {
				const output = await this.#backstop(prepared.execute(), deadline + BACKSTOP_MS, io);
				if (attempt.outcome() === "unknown") throw new OperationError("PROVIDER_UNAVAILABLE", "The write did not report its outcome.");
				result = this.#result(connector, op, terms, ref, output);
			} catch (error) {
				const effect = attempt.outcome();
				if (effect === "not_applied") {
					await settle({ effect: "not_applied" });
					throw error;
				}
				if (effect === "applied") {
					this.#log.warn(`Write applied without a usable result in run ${this.#runId}`, error);
					await settle({ effect: "applied", result: appliedWithoutResult() });
					return [appliedWithoutResult(), false];
				}
				this.#log.warn(`Write outcome unknown in run ${this.#runId}`, error);
				await settle({ effect: "unknown" });
				throw new OperationError("WRITE_UNCERTAIN", WRITE_MESSAGES.unknown, { cause: error });
			}
			if (attempt.outcome() === "not_applied") {
				// The connector sent nothing, or handled a refusal itself.
				await settle({ effect: "not_applied" });
				return [result, false];
			}
			try {
				await settle({ effect: "applied", result });
			} catch (error) {
				// The write took effect whatever its result: one that cannot be stored must not leave it dispatched,
				// which recovery would make uncertain.
				this.#log.warn(`The result of a write in run ${this.#runId} could not be stored`, error);
				await settle({ effect: "applied", result: appliedWithoutResult() });
			}
			return [result, false];
		} finally {
			attempt.close();
		}
	}

	/** `promise`, cut off at `at` (monotonic): the call's requests still in flight are aborted then. */
	async #backstop<T>(promise: Promise<T>, at: number, io: CallIo): Promise<T> {
		promise.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | null = null;
		const cut = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					io.abort();
					reject(new Error("The connector did not finish the write in time."));
				},
				Math.max(0, at - this.#clock.monotonic()),
			);
		});
		try {
			return await Promise.race([promise, cut]);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	#keepAlive(work: Promise<unknown>): void {
		const settled = work.then(
			() => {},
			() => {},
		);
		this.#pending.add(settled);
		void settled.then(() => this.#pending.delete(settled));
		this.#host.waitUntil(settled);
	}
}

export function createExecutor(context: ExecutorContext, host: ExecutorHost): ToolExecutor {
	return new ToolExecutor(context, host);
}
