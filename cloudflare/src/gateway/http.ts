// Provider HTTP: owned errors for provider responses, and the accounting of writes. A mutating operation
// may send exactly one mutating request, only from its execute step, only with time left before its
// deadline; what happened to that request tells the executor whether a failed write was applied, so it can
// allow a retry or pause writes.
//
// - Redirects are never followed (`redirect: "manual"`), so a write is never replayed to another URL and a
//   read never leaves the host it was authorized for.
// - The write attempt is bound to one call explicitly: the executor gives each call's client its own
//   `CallIo` (never a global), and closes the attempt once it has judged it, so a request from a promise
//   the connector left running is refused. A promise started in `prepare` sees the call's attempt once
//   `execute` opened it; the one write is still accounted and judged, and a second is refused.
// - A transport error on a write is always an unknown outcome: on Workers it cannot tell a connection that
//   never opened from one dropped after the request was sent.
// - Timeouts are per phase: the response's headers, then each chunk of its body, must arrive within the
//   timeout (for a write, within min(timeout, time left), fixed when it is sent). Bodies are read into
//   memory with a cap.
// - A fetch the platform refuses (private and non-Cloudflare IP literals) resolves to a 403 with
//   "error code: 1003", or Cloudflare's error page for it when the request has an Accept header, rather than
//   throwing; `platformRefusal` lets the Web connector recognise it.
// - A client built with `retries` sends a read the provider answered busy (429, 5xx, a rate limit `classify`
//   names) again after its Retry-After, or a short jittered backoff, but never waits longer than a few seconds
//   and never into the time an open write needs. Each new send is checked by the call's binding like the first.

import type { z } from "zod";
import { concatAll, fromUtf8, utf8 } from "../lib/bytes.ts";
import { type Json, parseJsonBytes } from "../lib/json.ts";
import { percentEncode } from "../lib/text.ts";
import { OperationError, type OperationErrorShape, type ProviderClient } from "./connector.ts";
import { RUN_ENDED_MESSAGE } from "./ledger.ts";

/**
 * What a write did to the provider. Starts unknown when sent: 2xx is applied; 400, 401, 403, 404, 409,
 * 412, 422 and 429 are not applied (refused); anything else (5xx, 418, 3xx) and every transport error stay
 * unknown, since `fetch` cannot tell "never connected" from "dropped after sending".
 */
export type Effect = "not_applied" | "applied" | "unknown";

/**
 * The one write a mutating operation may send, opened by the executor around `execute()` with the deadline
 * fixed at dispatch (a monotonic `performance.now()` instant). A request after the attempt is closed (a
 * promise the connector left running) is refused.
 */
export interface WriteAttempt {
	readonly deadline: number;
	sent: boolean;
	effect: Effect | null;
	closed: boolean;
}

/** What the executor hands a connector's client: `fetch` (injected in tests) and the open write attempt. */
export interface ProviderIo {
	fetch: typeof fetch;
	/** The write attempt the executor opened for this call's `execute()`, or null outside it. */
	currentWrite(): WriteAttempt | null;
	/** Monotonic milliseconds, for write deadlines. */
	now(): number;
}

export interface ProviderRequest {
	method: string;
	/** Relative to the client's base URL. */
	path: string;
	query?: { [name: string]: string | number | boolean | null | undefined };
	headers?: { [name: string]: string };
	json?: Json;
	form?: { [name: string]: string };
	body?: BodyInit;
	/** Whether the request writes. Defaults to POST, PUT, PATCH and DELETE; a read sent with POST passes false. */
	mutating?: boolean;
	/** Return a 3xx for the caller to judge instead of failing. Never for a write. */
	redirects?: boolean;
}

/**
 * A provider's HTTP client. Never follows redirects (`redirect: "manual"`).
 * Allows one mutating request, only inside an open write attempt, only with at least 2 s left (else
 * TIMED_OUT, not sent), with a timeout of min(20 s, time left). Maps errors: `classify` first, then 401
 * CONNECTION_UNAUTHORIZED "The {provider} connection is no longer authorized.", 403 `forbidden` (default
 * PROVIDER_FORBIDDEN "{provider} refused this request for the connected account."), 404 NOT_FOUND "{provider}
 * did not find this object.", 429 PROVIDER_RATE_LIMITED "{provider} is rate limiting requests. Try again
 * later.", other 4xx PROVIDER_REJECTED "{provider} rejected this request.", anything else PROVIDER_FAILED
 * "{provider} could not complete this request."; a transport error is PROVIDER_UNAVAILABLE "{provider}
 * could not be reached." `judge` decides a write's effect before the status does.
 */
export interface ProviderHttp {
	readonly provider: string;
	request(request: ProviderRequest): Promise<Response>;
	/** The body as JSON; a body that does not parse is PROVIDER_FAILED "{provider} returned an unexpected response." */
	json(request: ProviderRequest): Promise<Json>;
	/** The body validated by a schema; a mismatch is the same unexpected-response error. */
	parsed<T>(request: ProviderRequest, schema: z.ZodType<T>): Promise<T>;
	/**
	 * The body streamed up to `limit` bytes; more raises `tooLarge`. An error response is read up to 64 KiB
	 * and mapped with only content-type, retry-after and x-ratelimit-* kept. Never accounted as a write.
	 */
	bounded(request: ProviderRequest, limit: number, tooLarge: OperationErrorShape): Promise<Response>;
	/** `bounded` with FILE_TOO_LARGE "This file is larger than Minerva reads ({limit} bytes)." */
	download(request: ProviderRequest, limit: number): Promise<Response>;
}

export interface ProviderHttpOptions {
	provider: string;
	baseUrl: string;
	headers: { [name: string]: string };
	/** Seconds; default 20. */
	timeout?: number;
	forbidden?(provider: string, response: Response): OperationErrorShape;
	/**
	 * Names the error for a failed response when its status does not; null keeps the status's meaning.
	 * `body` is the text decoded leniently (U+FFFD for invalid bytes), on purpose: a provider's reason is
	 * still found in an error body with stray bytes. `bytes` is what was received, for a connector that reads
	 * it strictly with parseJsonBytes.
	 */
	classify?(provider: string, response: Response, body: string, bytes: Uint8Array): OperationErrorShape | null;
	/**
	 * What a response did to a write when its status does not tell (GraphQL answers failures with 200); null
	 * goes by the status. `body` and `bytes` as for `classify`.
	 */
	judge?(response: Response, body: string, bytes: Uint8Array): Effect | null;
	/**
	 * How many times a read the provider answered busy is sent again: a 429, a 500, 502, 503 or 504, or an error
	 * `classify` names PROVIDER_RATE_LIMITED. Default 0. A write is never sent again.
	 */
	retries?: number;
}

/**
 * One segment of a provider API path, `percentEncode`d. "", "." and ".." are refused with an ordinary
 * INVALID_ARGUMENTS error: the URL parser drops them or steps up a level, so an id such as ".." would
 * address another endpoint of the provider.
 */
export function segment(value: string): string {
	if (value === "" || value === "." || value === "..") {
		throw new OperationError("INVALID_ARGUMENTS", `${JSON.stringify(value)} is not a valid id or name.`);
	}
	return percentEncode(value);
}

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
/** The longest a busy read waits before it is sent again; a provider that asks for longer gets its error at once. */
export const MAX_RETRY_WAIT_MS = 4000;
/** A busy read's first wait when the provider names none, doubled for the next, each plus up to as much again. */
export const RETRY_BASE_MS = 250;
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

const NULL_BODY: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** Headers that describe the body as it was sent; the body returned is already decoded. */
const ENCODING_HEADERS: ReadonlySet<string> = new Set(["content-encoding", "content-length"]);

/** A connector broke the HTTP contract. Logged; the model sees the generic failure. */
export class ProgrammingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProgrammingError";
	}
}

/**
 * A request the call's binding refused before anything was sent: the run may no longer start a provider
 * request (revoked, stopped, expired or replaced; ARCHITECTURE.md: Strict revocation), or the call was cancelled.
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

/** The one write of a mutating operation's execute step. */
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

	/** The call ended: every later request is refused. */
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function owned(error: OperationErrorShape): OperationError {
	return error instanceof OperationError ? error : new OperationError(error.code, error.message);
}

/** Milliseconds a Retry-After header asks for, in seconds or as a date; null without one that parses. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	// An HTTP date, which is always in GMT; Date.parse would read much else as a date.
	const at = / GMT$/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function defaultForbidden(provider: string): OperationErrorShape {
	return new OperationError("PROVIDER_FORBIDDEN", `${provider} refused this request for the connected account.`);
}

/** The platform's refusal as text, for a request without an Accept header. */
const PLAIN_REFUSAL = /^error code: (\d{4})\s*$/;
/** The heading of Cloudflare's error page, `Error NNNN`, which a request with an Accept header gets instead. */
const PAGE_REFUSAL = /<span data-translate="error">Error<\/span>\s*<span>(\d{4})<\/span>/;

/**
 * The platform's code when Cloudflare refused a Worker's fetch itself rather than the provider answering:
 * a 403 from `server: cloudflare` whose body is `error code: NNNN` (1003 for private, loopback,
 * link-local and non-Cloudflare IP literals; 1002 and 1102 for names that resolve to them), else null.
 * To a request with an Accept header (any value, the wildcard and text/plain included; the Web connector's has one),
 * the body is instead Cloudflare's HTML error page (text/html, about 6.5 KB) headed `Error NNNN` (measured
 * on the account 2026-10-12: 1002 for a name of a private IPv4 address, 1102 for localtest.me). Measured, not
 * documented. The Web connector's `classify` reports it.
 */
export function platformRefusal(response: Response, body: string): number | null {
	if (response.headers.get("server")?.toLowerCase() !== "cloudflare") return null;
	const plain = PLAIN_REFUSAL.exec(body);
	if (plain !== null) return Number(plain[1]);
	if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return null;
	const page = PAGE_REFUSAL.exec(body);
	return page === null ? null : Number(page[1]);
}

/** A provider's HTTP client, built by a connector's `client()` on the call's io. */
export class ProviderHTTP implements ProviderHttp, ProviderClient {
	readonly provider: string;
	readonly #io: ProviderIo;
	readonly #base: string;
	readonly #headers: { [name: string]: string };
	readonly #timeoutMs: number;
	readonly #forbidden: (provider: string, response: Response) => OperationErrorShape;
	readonly #classify: ProviderHttpOptions["classify"];
	readonly #judge: ProviderHttpOptions["judge"];
	readonly #retries: number;
	#closed = false;

	constructor(io: ProviderIo, options: ProviderHttpOptions) {
		this.provider = options.provider;
		this.#io = io;
		// The base path always ends in "/", and a relative path is appended to it.
		this.#base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
		this.#headers = { ...options.headers };
		this.#timeoutMs = (options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
		this.#forbidden = options.forbidden ?? defaultForbidden;
		this.#classify = options.classify;
		this.#judge = options.judge;
		this.#retries = options.retries ?? 0;
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
			// null is an empty value; booleans are written in lowercase.
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
			body = JSON.stringify(request.json);
			type = "application/json";
		} else if (request.form !== undefined) {
			body = new URLSearchParams(request.form).toString();
			type = "application/x-www-form-urlencoded";
		} else if (request.body !== undefined) {
			body = request.body;
		}
		// A Content-Type the client or the request set wins over the encoding's.
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

	/**
	 * How long to wait before sending a read again after `error`, its `retry`th retry, or null to fail with it: the
	 * provider is not busy, the retries are used up, it asks for longer than MAX_RETRY_WAIT_MS, or the wait would
	 * leave the call's open write less than MIN_WRITE_MS.
	 */
	#busyWait(error: OperationError, response: Response, retry: number): number | null {
		if (retry >= this.#retries) return null;
		if (error.code !== "PROVIDER_RATE_LIMITED" && !(error.code === "PROVIDER_FAILED" && BUSY_STATUSES.has(response.status))) return null;
		const asked = retryAfterMs(response.headers.get("retry-after"));
		if (asked !== null && asked > MAX_RETRY_WAIT_MS) return null;
		const base = asked ?? RETRY_BASE_MS * 2 ** retry;
		const wait = Math.min(MAX_RETRY_WAIT_MS, base + Math.random() * (asked === null ? base : RETRY_BASE_MS));
		const attempt = this.#io.currentWrite();
		if (attempt !== null && !attempt.closed && attempt.deadline - this.#io.now() - wait < MIN_WRITE_MS) return null;
		return wait;
	}

	#unavailable(cause: unknown): OperationError {
		return new OperationError("PROVIDER_UNAVAILABLE", `${this.provider} could not be reached.`, { cause });
	}

	/**
	 * Sends one request, and a read the provider answered busy again up to `retries` times. `mutating` defaults by
	 * method; reads sent with POST must say so. With `redirects`, a 3xx is returned for the caller to judge instead
	 * of being an error; redirects are never followed. The body is read in full (up to MAX_RESPONSE_BODY) and
	 * returned decoded.
	 */
	async request(request: ProviderRequest): Promise<Response> {
		if (this.#closed) throw new ProgrammingError("Cannot send a request, as the client has been closed.");
		const method = request.method.toUpperCase();
		const mutating = request.mutating ?? MUTATING_METHODS.has(method);
		if (mutating && request.redirects) throw new ProgrammingError("A write is never redirected.");
		const url = this.#url(request);
		const init = this.#init(request, method);
		const attempt = mutating ? this.#beginWrite() : null;
		for (let retry = 0; ; retry++) {
			const sent = await this.#send(url, init, attempt, request.redirects ?? false);
			if (sent.error === null) return sent.response;
			const wait = attempt === null ? this.#busyWait(sent.error, sent.response, retry) : null;
			if (wait === null) throw sent.error;
			await sleep(wait);
		}
	}

	/** One exchange of `request`: the response, and the error it maps to unless it is returned. */
	async #send(url: string, init: RequestInit, attempt: WriteAttempt | null, redirects: boolean): Promise<{ response: Response; error: OperationError | null }> {
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
			// fetch cannot tell a connection that never opened from one dropped after sending.
			if (attempt !== null) attempt.effect = "unknown";
			throw this.#unavailable(error);
		}
		const success = isSuccess(exchanged.status);
		const body = success ? exchanged.body : exchanged.body.subarray(0, MAX_ERROR_BODY);
		const fresh = () => responseOf(exchanged, body, (name) => !ENCODING_HEADERS.has(name));
		// Read leniently (U+FFFD for invalid bytes) for `classify` and `judge`, which look for a provider's
		// reason in an error body; a body read as data goes through parseJsonBytes instead.
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
		// Every 3xx, with a Location or not; the caller judges it.
		if (redirects && response.status >= 300 && response.status < 400) return { response, error: null };
		return { response, error: success ? null : this.error(response, text, body) };
	}

	/** The body as JSON (parseJsonBytes); one that does not parse is an unexpected response. */
	async json(request: ProviderRequest): Promise<Json> {
		const response = await this.request(request);
		try {
			return parseJsonBytes(await response.arrayBuffer());
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
		for (let retry = 0; ; retry++) {
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
			const response = responseOf(exchanged, body, (name) => KEPT_ERROR_HEADERS.has(name));
			const error = this.error(response, fromUtf8(body), body);
			const wait = this.#busyWait(error, response, retry);
			if (wait === null) throw error;
			await sleep(wait);
		}
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
