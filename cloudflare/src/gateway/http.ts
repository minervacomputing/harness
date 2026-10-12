// Provider HTTP, ported from backend/connectors/http.py (connectors 7.6): owned errors for provider
// responses, and the accounting of writes. A mutating operation may send exactly one mutating request,
// only from its execute step, only with time left before its deadline; what happened to that request
// tells the executor whether a failed write was applied, so it can allow a retry or pause writes.
//
// What changes with `fetch` (connectors 7.6 CHANGE, risks 7 to 9):
// - Redirects are never followed (`redirect: "manual"`), so a write is never replayed to another URL and a
//   read never leaves the host it was authorized for.
// - The write attempt is bound to one call explicitly: the executor gives each call's client its own
//   `CallIo` (never a global), and closes the attempt once it has judged it, so a request from a promise
//   the connector left running is refused. A promise started in `prepare` sees the call's attempt once
//   `execute` opened it, where Python's context variable would not; the one write is still accounted and
//   judged, and a second is refused.
// - A transport error on a write is always an unknown outcome: on Workers it cannot tell a connection that
//   never opened from one dropped after the request was sent.
// - Timeouts are per phase, as httpx's: the response's headers, then each chunk of its body, must arrive
//   within the timeout (for a write, within min(timeout, time left), fixed when it is sent). Bodies are
//   read into memory with a cap, which httpx did not have.
// - A fetch the platform refuses (private and non-Cloudflare IP literals) resolves to a 403 with
//   "error code: 1003" rather than throwing; `platformRefusal` lets the Web connector recognise it.

import type { z } from "zod";
import type {
	Effect,
	OperationErrorShape,
	ProviderClient,
	ProviderHttp,
	ProviderHttpOptions,
	ProviderIo,
	ProviderRequest,
	WriteAttempt,
} from "../contracts/connectors.ts";
import { concatAll, fromUtf8, fromUtf8Strict, utf8 } from "../lib/bytes.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { OperationError } from "./connector.ts";
import { RUN_ENDED_MESSAGE } from "./ledger.ts";

export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The provider refused these requests, so the write they carried was not applied. */
export const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 412, 422, 429]);
/** Never start a write that could not finish before its deadline. */
export const MIN_WRITE_MS = 2000;
/** Enough of an error response to read the provider's reason. */
export const MAX_ERROR_BODY = 64 * 1024;
/** What `request` and `json` read of a successful response; more is an unexpected response. */
export const MAX_RESPONSE_BODY = 16 * 1024 * 1024;
export const KEPT_ERROR_HEADERS: ReadonlySet<string> = new Set(["content-type", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]);
export const DEFAULT_TIMEOUT_SECONDS = 20;

const NULL_BODY: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** Headers that describe the body as it was sent; the body returned is already decoded. */
const ENCODING_HEADERS: ReadonlySet<string> = new Set(["content-encoding", "content-length"]);

/** Python's RuntimeError: a connector broke the HTTP contract. Logged; the model sees the generic failure. */
export class ProgrammingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProgrammingError";
	}
}

/**
 * A request the call's binding refused before anything was sent: the run may no longer start a provider
 * request (revoked, stopped, expired or replaced; plan: Strict revocation), or the call was cancelled.
 */
export class NotSent extends OperationError {
	constructor() {
		super("RUN_ENDED", RUN_ENDED_MESSAGE);
		this.name = "NotSent";
	}
}

/** A phase of a request (its headers, or one chunk of its body) took longer than the timeout. */
export class PhaseTimeout extends Error {
	constructor() {
		super("The provider did not answer in time.");
		this.name = "TimeoutError";
	}
}

/** The one write of a mutating operation's execute step (http.py `WriteAttempt`). */
export class WriteAttemptState implements WriteAttempt {
	/** Monotonic milliseconds. */
	readonly deadline: number;
	sent = false;
	effect: Effect | null = null;
	/** Set once the executor judged the attempt; a request sent later would not be accounted for, so it is refused. */
	closed = false;

	constructor(deadline: number) {
		this.deadline = deadline;
	}

	close(): void {
		this.closed = true;
	}

	/** What the execute step did to the provider. Closes the attempt. */
	outcome(): Effect {
		this.close();
		if (!this.sent) return "not_applied";
		return this.effect ?? "unknown";
	}
}

export interface CallIoOptions {
	fetch: typeof fetch;
	/** Monotonic milliseconds. */
	now(): number;
	/**
	 * Whether the call may start a provider request now. Run synchronously right before each fetch, so no
	 * request starts once the run is revoked, stopped, expired or replaced, or the call was cancelled.
	 */
	admits(): boolean;
}

/** What the executor hands one call's provider client: its `fetch`, its write attempt and its clock. */
export class CallIo implements ProviderIo {
	readonly fetch: typeof fetch;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #admits: () => boolean;
	readonly #controller = new AbortController();
	#write: WriteAttemptState | null = null;
	#closed = false;

	constructor(options: CallIoOptions) {
		this.#fetch = options.fetch;
		this.#now = options.now;
		this.#admits = options.admits;
		this.fetch = (input, init) => this.#send(input, init);
	}

	now(): number {
		return this.#now();
	}

	currentWrite(): WriteAttemptState | null {
		return this.#write;
	}

	/** Opens the write attempt around `execute()`, with the deadline fixed at dispatch. */
	openWrite(deadline: number): WriteAttemptState {
		this.#write = new WriteAttemptState(deadline);
		return this.#write;
	}

	/** Aborts the call's requests still in flight (the executor's backstop). */
	abort(): void {
		this.#controller.abort(new PhaseTimeout());
	}

	/** The call ended: every later request is refused, as a closed httpx client refuses. */
	close(): void {
		this.#closed = true;
		this.#write?.close();
	}

	#send(input: RequestInfo | URL, init?: RequestInit<RequestInitCfProperties>): Promise<Response> {
		if (this.#closed) return Promise.reject(new ProgrammingError("Cannot send a request, as the client has been closed."));
		if (!this.#admits()) return Promise.reject(new NotSent());
		const signal = init?.signal ? AbortSignal.any([init.signal, this.#controller.signal]) : this.#controller.signal;
		// Called without a receiver, as the runtime's fetch expects.
		return (0, this.#fetch)(input, { ...init, signal });
	}
}

/**
 * The io for a provider call outside a run (a connection's `account()`, the access page's `discover`,
 * `children` and `describe`): no write attempt, so every write is refused, and no run to check.
 */
export function settingsIo(fetch: typeof globalThis.fetch, now: () => number = () => performance.now()): CallIo {
	return new CallIo({ fetch, now, admits: () => true });
}

interface Exchanged {
	status: number;
	statusText: string;
	headers: Headers;
	body: Uint8Array;
	/** The body was longer than the cap and only its start was read. */
	over: boolean;
}

function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** `promise`, or the abort's reason if that comes first; a later rejection of `promise` is not left unhandled. */
function unlessAborted<T>(promise: Promise<T>, aborted: Promise<never>): Promise<T> {
	promise.catch(() => {});
	return Promise.race([promise, aborted]);
}

/** Sends one request and reads its body up to the status's cap, each phase within `phaseMs`. */
async function exchange(io: ProviderIo, url: string, init: RequestInit, phaseMs: number, capFor: (status: number) => number): Promise<Exchanged> {
	const controller = new AbortController();
	const aborted = rejectOnAbort(controller.signal);
	aborted.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | null = null;
	const arm = () => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new PhaseTimeout()), Math.max(0, phaseMs));
	};
	arm();
	try {
		const response = await unlessAborted(io.fetch(url, { ...init, signal: controller.signal }), aborted);
		const cap = capFor(response.status);
		const chunks: Uint8Array[] = [];
		let size = 0;
		let over = false;
		const reader = response.body?.getReader();
		if (reader !== undefined) {
			try {
				for (;;) {
					arm();
					const { done, value } = await unlessAborted(reader.read(), aborted);
					if (done) break;
					chunks.push(value);
					size += value.byteLength;
					if (size > cap) {
						over = true;
						break;
					}
				}
			} finally {
				// Release the rest of a body that was not read to its end.
				reader.cancel().catch(() => {});
			}
		}
		return { status: response.status, statusText: response.statusText, headers: response.headers, body: concatAll(chunks), over };
	} finally {
		clearTimeout(timer);
	}
}

function responseOf(exchanged: Exchanged, body: Uint8Array, keep: (name: string) => boolean): Response {
	const headers = new Headers();
	exchanged.headers.forEach((value, name) => {
		if (keep(name)) headers.append(name, value);
	});
	return new Response(NULL_BODY.has(exchanged.status) ? null : body, { status: exchanged.status, statusText: exchanged.statusText, headers });
}

function owned(error: OperationErrorShape): OperationError {
	return error instanceof OperationError ? error : new OperationError(error.code, error.message);
}

/** JSON's text from bytes as `json.loads` reads them: UTF-8, a byte order mark skipped, invalid UTF-8 refused. */
function jsonText(bytes: Uint8Array): string {
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	return fromUtf8Strict(bytes.subarray(start));
}

export function defaultForbidden(provider: string): OperationErrorShape {
	return new OperationError("PROVIDER_FORBIDDEN", `${provider} refused this request for the connected account.`);
}

/**
 * The platform's code when Cloudflare refused a Worker's fetch itself rather than the provider answering:
 * a 403 from `server: cloudflare` whose body is `error code: NNNN` (1003 for private, loopback,
 * link-local and non-Cloudflare IP literals; 1002 and 1102 for names that resolve to them), else null.
 * Measured, not documented (plan: Spike results). The Web connector's `classify` reports it as today.
 */
export function platformRefusal(response: Response, body: string): number | null {
	if (response.headers.get("server")?.toLowerCase() !== "cloudflare") return null;
	const match = /^error code: (\d{4})\s*$/.exec(body);
	return match === null ? null : Number(match[1]);
}

/** A provider's HTTP client (http.py `ProviderHTTP`), built by a connector's `client()` on the call's io. */
export class ProviderHTTP implements ProviderHttp, ProviderClient {
	readonly provider: string;
	readonly #io: ProviderIo;
	readonly #base: string;
	readonly #headers: { [name: string]: string };
	readonly #timeoutMs: number;
	readonly #forbidden: (provider: string, response: Response) => OperationErrorShape;
	readonly #classify: ProviderHttpOptions["classify"];
	readonly #judge: ProviderHttpOptions["judge"];
	#closed = false;

	constructor(io: ProviderIo, options: ProviderHttpOptions) {
		this.provider = options.provider;
		this.#io = io;
		// As httpx merges: the base path always ends in "/", and a relative path is appended to it.
		this.#base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
		this.#headers = { ...options.headers };
		this.#timeoutMs = (options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
		this.#forbidden = options.forbidden ?? defaultForbidden;
		this.#classify = options.classify;
		this.#judge = options.judge;
	}

	async close(): Promise<void> {
		this.#closed = true;
	}

	#url(request: ProviderRequest): string {
		const absolute = /^[a-z][a-z0-9+.-]*:/i.test(request.path) || request.path.startsWith("//");
		let url: URL;
		try {
			url = new URL(absolute ? request.path : this.#base + request.path.replace(/^\/+/, ""));
		} catch {
			throw new ProgrammingError(`Not a URL: ${request.path}`);
		}
		for (const [name, value] of Object.entries(request.query ?? {})) {
			if (value === undefined) continue;
			// httpx writes None as an empty value and booleans in lowercase.
			url.searchParams.append(name, value === null ? "" : String(value));
		}
		return url.toString();
	}

	#init(request: ProviderRequest, method: string): RequestInit {
		const headers = new Headers(this.#headers);
		for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
		let body: BodyInit | null = null;
		let type: string | null = null;
		const sources = [request.json !== undefined, request.form !== undefined, request.body !== undefined].filter(Boolean).length;
		if (sources > 1) throw new ProgrammingError("A request has one body: json, form or body.");
		if (request.json !== undefined) {
			// httpx's encoding: compact, non-ASCII as is.
			body = JSON.stringify(request.json);
			type = "application/json";
		} else if (request.form !== undefined) {
			body = new URLSearchParams(request.form).toString();
			type = "application/x-www-form-urlencoded";
		} else if (request.body !== undefined) {
			body = request.body;
		}
		// As httpx: a Content-Type the client or the request set wins over the encoding's.
		if (type !== null && !headers.has("content-type")) headers.set("content-type", type);
		return { method, headers, body, redirect: "manual" };
	}

	#beginWrite(): WriteAttempt {
		const attempt = this.#io.currentWrite();
		if (attempt === null || attempt.closed) throw new ProgrammingError("Provider writes are only allowed in the execute step of a mutating operation.");
		if (attempt.sent) throw new ProgrammingError("An operation may send only one provider write.");
		if (attempt.deadline - this.#io.now() < MIN_WRITE_MS) throw new OperationError("TIMED_OUT", "The write was not sent because its time ran out.");
		attempt.sent = true;
		return attempt;
	}

	#unavailable(cause: unknown): OperationError {
		return new OperationError("PROVIDER_UNAVAILABLE", `${this.provider} could not be reached.`, { cause });
	}

	/**
	 * Sends one request. `mutating` defaults by method; reads sent with POST must say so. With `redirects`,
	 * a 3xx is returned for the caller to judge instead of being an error; redirects are never followed.
	 * The body is read in full (up to MAX_RESPONSE_BODY) and returned decoded.
	 */
	async request(request: ProviderRequest): Promise<Response> {
		if (this.#closed) throw new ProgrammingError("Cannot send a request, as the client has been closed.");
		const method = request.method.toUpperCase();
		const mutating = request.mutating ?? MUTATING_METHODS.has(method);
		if (mutating && request.redirects) throw new ProgrammingError("A write is never redirected.");
		const url = this.#url(request);
		const init = this.#init(request, method);
		const attempt = mutating ? this.#beginWrite() : null;
		const phaseMs = attempt === null ? this.#timeoutMs : Math.min(this.#timeoutMs, attempt.deadline - this.#io.now());
		let exchanged: Exchanged;
		try {
			exchanged = await exchange(this.#io, url, init, phaseMs, (status) => (isSuccess(status) ? MAX_RESPONSE_BODY : MAX_ERROR_BODY));
		} catch (error) {
			if (error instanceof NotSent) {
				if (attempt !== null) attempt.effect = "not_applied";
				throw error;
			}
			if (error instanceof ProgrammingError) throw error;
			// fetch cannot tell a connection that never opened from one dropped after sending (risk 9).
			if (attempt !== null) attempt.effect = "unknown";
			throw this.#unavailable(error);
		}
		const success = isSuccess(exchanged.status);
		const body = success ? exchanged.body : exchanged.body.subarray(0, MAX_ERROR_BODY);
		const fresh = () => responseOf(exchanged, body, (name) => !ENCODING_HEADERS.has(name));
		const text = fromUtf8(body);
		if (attempt !== null) {
			// Unknown until judged, so a judge that throws leaves nothing claimed. A body cut at the cap cannot
			// be judged, so a write with a judge stays unknown then.
			attempt.effect = "unknown";
			const judgeable = !(exchanged.over && this.#judge !== undefined);
			const judged = judgeable && this.#judge !== undefined ? this.#judge(fresh(), text, body) : null;
			if (judged !== null) attempt.effect = judged;
			else if (judgeable && success) attempt.effect = "applied";
			else if (judgeable && REFUSED_STATUSES.has(exchanged.status)) attempt.effect = "not_applied";
		}
		if (success && exchanged.over) throw this.unexpected();
		const response = fresh();
		// Every 3xx, with a Location or not, as httpx 0.28's `is_redirect` counts them; the caller judges it.
		if (request.redirects && response.status >= 300 && response.status < 400) return response;
		if (!success) throw this.error(response, text, body);
		return response;
	}

	/** The body as JSON, read with parseJson; one that does not parse is an unexpected response. */
	async json(request: ProviderRequest): Promise<Json> {
		const response = await this.request(request);
		const bytes = new Uint8Array(await response.arrayBuffer());
		try {
			return parseJson(jsonText(bytes));
		} catch (error) {
			throw this.unexpected(error);
		}
	}

	/** A JSON response read with `schema`; one that does not fit is an unexpected response. */
	async parsed<T>(request: ProviderRequest, schema: z.ZodType<T>): Promise<T> {
		const data = await this.json(request);
		const result = await schema.safeParseAsync(data);
		if (!result.success) throw this.unexpected(result.error);
		return result.data;
	}

	/**
	 * A read whose body is streamed and refused with `tooLarge` once it exceeds `limit` bytes; the response
	 * returned is read in full. A read sent with POST (a GraphQL query) passes its method; it is never
	 * accounted as a write, so a write must not be sent this way. An error response is read up to 64 KiB
	 * and mapped with only its type and rate limit headers kept.
	 */
	async bounded(request: ProviderRequest, limit: number, tooLarge: OperationErrorShape): Promise<Response> {
		if (this.#closed) throw new ProgrammingError("Cannot send a request, as the client has been closed.");
		const method = request.method.toUpperCase();
		const url = this.#url(request);
		const init = this.#init(request, method);
		let exchanged: Exchanged;
		try {
			exchanged = await exchange(this.#io, url, init, this.#timeoutMs, (status) => (isSuccess(status) ? limit : MAX_ERROR_BODY));
		} catch (error) {
			if (error instanceof NotSent || error instanceof ProgrammingError) throw error;
			throw this.#unavailable(error);
		}
		if (isSuccess(exchanged.status)) {
			if (exchanged.over) throw owned(tooLarge);
			return responseOf(exchanged, exchanged.body, (name) => !ENCODING_HEADERS.has(name));
		}
		const body = exchanged.body.subarray(0, MAX_ERROR_BODY);
		throw this.error(
			responseOf(exchanged, body, (name) => KEPT_ERROR_HEADERS.has(name)),
			fromUtf8(body),
			body,
		);
	}

	/** `bounded` with FILE_TOO_LARGE. */
	download(request: ProviderRequest, limit: number): Promise<Response> {
		return this.bounded(request, limit, new OperationError("FILE_TOO_LARGE", `This file is larger than Minerva reads (${limit} bytes).`));
	}

	unexpected(cause?: unknown): OperationError {
		return new OperationError("PROVIDER_FAILED", `${this.provider} returned an unexpected response.`, { cause });
	}

	/** The owned error for a failed response: `classify` first, then the status. `bytes` defaults to `body`'s. */
	error(response: Response, body: string, bytes: Uint8Array = utf8(body)): OperationError {
		const named = this.#classify?.(this.provider, response.clone(), body, bytes) ?? null;
		if (named !== null) return owned(named);
		const status = response.status;
		if (status === 401) return new OperationError("CONNECTION_UNAUTHORIZED", `The ${this.provider} connection is no longer authorized.`);
		if (status === 403) return owned(this.#forbidden(this.provider, response.clone()));
		if (status === 404) return new OperationError("NOT_FOUND", `${this.provider} did not find this object.`);
		if (status === 429) return new OperationError("PROVIDER_RATE_LIMITED", `${this.provider} is rate limiting requests. Try again later.`);
		if (status >= 400 && status < 500) return new OperationError("PROVIDER_REJECTED", `${this.provider} rejected this request.`);
		return new OperationError("PROVIDER_FAILED", `${this.provider} could not complete this request.`);
	}
}
