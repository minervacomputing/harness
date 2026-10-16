// The fake provider of the test build (src/faults/): the Notes API and its OAuth token endpoint, as a
// Durable Object per workspace, so what it applied survives the crashes of the objects that call it. It
// records every request with the time it arrived, rotates refresh tokens on every refresh (an old one is
// refused with `invalid_grant`, as rotating providers do), accepts only the access tokens it issued, and
// can hold its answers to a path for a while, to keep a request in flight. Reached only through the test
// build's network port (ports.ts), never from outside the Worker.
//
// Its token endpoint redeems a code once, for the client and redirect URI it was issued to, with the verifier of its
// challenge, and the tokens it issues belong to the account that consented (`/me`).
//
// It also hosts the workspace's fake Laravel (laravel.ts), at LARAVEL_HOST, in tables of its own; its requests are not in the
// Notes request log. Its points, `laravel:<operation>` (`leaseToken`, `reportUnauthorized`, `deliverFacts`), fire once the
// operation has written its rows, before its answer leaves (`abort` or `note`).

import { DurableObject } from "cloudflare:workers";
import { laravel } from "@minerva/contract/internal";
import { settings } from "../config.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { NOTES_CLIENT } from "./connector.ts";
import { type FakeConnection, type FakeRun, LARAVEL_SCHEMA, LARAVEL_TABLES, type LaravelView, SqlLaravel, hostedToken } from "./laravel.ts";
import { type Fault, type Fired, planOf } from "./plan.ts";
import { LARAVEL_HOST } from "./settings.ts";

export interface ProviderSetup {
	folders?: { id: string; name: string; notes?: string[] }[];
	/** The access and refresh tokens the connection starts with. */
	access?: string;
	refresh?: string;
	/** Milliseconds to hold answers to requests whose "METHOD /path" starts with a key. */
	delays?: { [prefix: string]: number };
}

export interface ProviderRequestLog {
	seq: number;
	at: number;
	method: string;
	path: string;
	/** The fake bearer token it carried, or "" (the token endpoint's). */
	token: string;
	status: number;
}

export interface ProviderState {
	notes: { id: number; folder: string; title: string }[];
	requests: ProviderRequestLog[];
	refresh: string | null;
	rotations: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, title TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS tokens (value TEXT PRIMARY KEY, kind TEXT NOT NULL, valid INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS requests (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, token TEXT NOT NULL, status INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT, scope TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, used INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS owners (token TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_name TEXT NOT NULL) STRICT;
`;

/** The account the fake provider's tokens belong to unless a consent named another. */
export const NOTES_ACCOUNT = { id: "notes-account-1", name: "Notes account" };

const DEFAULT_FOLDERS = [
	{ id: "inbox", name: "Inbox", notes: ["Buy milk", "Call Ada"] },
	{ id: "archive", name: "Archive", notes: ["Old note"] },
];

function json(status: number, body: Json): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The Laravel operation a path is, by the contract's paths. */
const OPERATIONS = new Map<string | undefined, string>(Object.entries(laravel).map(([name, procedure]) => [procedure["~orpc"].route.path, name]));

export class FaultProvider extends DurableObject<Env> {
	readonly #laravel: SqlLaravel;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA + LARAVEL_SCHEMA);
		this.#laravel = new SqlLaravel(ctx.storage, { token: hostedToken(env), environment: settings(env).internal?.environment ?? "" });
	}

	#sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	#setting(key: string): string | null {
		return this.#sql().exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	/** Starts over: folders and their notes, the connection's tokens, delays; the request log, the fake Laravel and the plan are cleared. */
	reset(setup: ProviderSetup = {}): void {
		const sql = this.#sql();
		planOf(this.ctx).set([]);
		this.ctx.storage.transactionSync(() => {
			for (const table of ["folders", "notes", "tokens", "requests", "settings", "codes", "owners", ...LARAVEL_TABLES]) sql.exec(`DELETE FROM ${table}`);
			for (const folder of setup.folders ?? DEFAULT_FOLDERS) {
				sql.exec("INSERT INTO folders (id, name) VALUES (?, ?)", folder.id, folder.name);
				for (const title of folder.notes ?? []) sql.exec("INSERT INTO notes (folder, title) VALUES (?, ?)", folder.id, title);
			}
			sql.exec("INSERT INTO tokens (value, kind, valid) VALUES (?, 'access', 1)", setup.access ?? "notes-access-0");
			sql.exec("INSERT INTO tokens (value, kind, valid) VALUES (?, 'refresh', 1)", setup.refresh ?? "notes-refresh-0");
			sql.exec("INSERT INTO settings (key, value) VALUES ('delays', ?), ('rotations', '0')", JSON.stringify(setup.delays ?? {}));
		});
	}

	/** Tokens a reconnect brings: valid from now on, as a provider's new grant would be. */
	issue(access: string, refresh: string): void {
		this.#sql().exec("INSERT OR REPLACE INTO tokens (value, kind, valid) VALUES (?, 'access', 1), (?, 'refresh', 1)", access, refresh);
	}

	setDelays(delays: { [prefix: string]: number }): void {
		this.#sql().exec("INSERT INTO settings (key, value) VALUES ('delays', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(delays));
	}

	state(): ProviderState {
		const sql = this.#sql();
		return {
			notes: sql.exec<{ id: number; folder: string; title: string }>("SELECT id, folder, title FROM notes ORDER BY id").toArray(),
			requests: sql.exec<{ seq: number; at: number; method: string; path: string; token: string; status: number }>("SELECT * FROM requests ORDER BY seq").toArray(),
			refresh: sql.exec<{ value: string }>("SELECT value FROM tokens WHERE kind = 'refresh' AND valid = 1").toArray()[0]?.value ?? null,
			rotations: Number(this.#setting("rotations") ?? 0),
		};
	}

	/** The fake Laravel holds the run, and the run's conversation. */
	laravelHold(id: string, run: FakeRun): void {
		this.#laravel.hold(id, run);
	}

	laravelConnection(id: string, connection: FakeConnection): void {
		this.#laravel.setConnection(id, connection);
	}

	laravelState(conversation: string): LaravelView {
		return this.#laravel.view(conversation);
	}

	/** The fake Laravel answers the next `deliveries` deliveries 503. */
	laravelFail(deliveries: number): void {
		this.#laravel.failDeliveries(deliveries);
	}

	/** Replaces the plan of this object's points. */
	faultPlan(faults: Fault[]): void {
		planOf(this.ctx).set(faults);
	}

	faultFired(): Fired[] {
		return planOf(this.ctx).fired();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname === LARAVEL_HOST) return this.#answerLaravel(request, url);
		const at = Date.now();
		const key = `${request.method} ${url.pathname}`;
		const delays = parseJson(this.#setting("delays") ?? "{}") as { [prefix: string]: number };
		const delay = Object.entries(delays).find(([prefix]) => key.startsWith(prefix))?.[1] ?? 0;
		const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		const seq = this.#sql()
			.exec<{ seq: number }>("INSERT INTO requests (at, method, path, token, status) VALUES (?, ?, ?, ?, 0) RETURNING seq", at, request.method, url.pathname, token)
			.one().seq;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		const response = await this.#answer(request, url);
		this.#sql().exec("UPDATE requests SET status = ? WHERE seq = ?", response.status, seq);
		return response;
	}

	async #answerLaravel(request: Request, url: URL): Promise<Response> {
		const response = await this.#laravel.fetch(request);
		const operation = OPERATIONS.get(url.pathname);
		if (operation !== undefined) await planOf(this.ctx).at(`laravel:${operation}`, { detail: String(response.status) }, ["abort", "note"]);
		return response;
	}

	async #answer(request: Request, url: URL): Promise<Response> {
		const sql = this.#sql();
		if (request.method === "POST" && url.pathname === "/token") return this.#token(await request.text());
		const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		const known = sql.exec("SELECT 1 FROM tokens WHERE kind = 'access' AND valid = 1 AND value = ?", bearer).toArray().length > 0;
		if (!known) return json(401, { error: "invalid_token" });
		if (request.method === "GET" && url.pathname === "/me") {
			const owner = sql.exec<{ account_id: string; account_name: string }>("SELECT account_id, account_name FROM owners WHERE token = ?", bearer).toArray()[0];
			return json(200, owner ? { id: owner.account_id, name: owner.account_name } : NOTES_ACCOUNT);
		}
		if (request.method === "GET" && url.pathname === "/folders") return json(200, sql.exec<{ id: string; name: string }>("SELECT id, name FROM folders ORDER BY id").toArray());
		const one = /^\/notes\/([0-9]+)$/.exec(url.pathname);
		if (request.method === "GET" && one) {
			const note = sql.exec<{ id: number; title: string }>("SELECT id, title FROM notes WHERE id = ?", Number(one[1])).toArray()[0];
			return note ? json(200, { id: String(note.id), title: note.title }) : json(404, { error: "not_found" });
		}
		const match = /^\/folders\/([a-z0-9-]+)\/notes$/.exec(url.pathname);
		const folder = match?.[1];
		if (folder === undefined || sql.exec("SELECT 1 FROM folders WHERE id = ?", folder).toArray().length === 0) return json(404, { error: "not_found" });
		if (request.method === "GET") {
			const notes = sql.exec<{ id: number; title: string }>("SELECT id, title FROM notes WHERE folder = ? ORDER BY id", folder).toArray();
			return json(
				200,
				notes.map((note) => ({ id: String(note.id), title: note.title })),
			);
		}
		if (request.method === "POST") {
			const body = parseJson(await request.text()) as { title?: unknown };
			if (typeof body.title !== "string") return json(422, { error: "title" });
			const id = sql.exec<{ id: number }>("INSERT INTO notes (folder, title) VALUES (?, ?) RETURNING id", folder, body.title).one().id;
			return json(200, { id: String(id), title: body.title });
		}
		return json(405, { error: "method" });
	}

	/** A refresh rotates both tokens; the refresh token it was given is spent, so it is refused next time. */
	async #token(body: string): Promise<Response> {
		const sql = this.#sql();
		const form = new URLSearchParams(body);
		if (form.get("client_id") !== NOTES_CLIENT.clientId || form.get("client_secret") !== NOTES_CLIENT.clientSecret) return json(401, { error: "invalid_client" });
		if (form.get("grant_type") === "authorization_code") return this.#redeem(form);
		if (form.get("grant_type") !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
		const given = form.get("refresh_token") ?? "";
		const valid = sql.exec("SELECT 1 FROM tokens WHERE kind = 'refresh' AND valid = 1 AND value = ?", given).toArray().length > 0;
		if (!valid) return json(400, { error: "invalid_grant" });
		const rotations = Number(this.#setting("rotations") ?? 0) + 1;
		const access = `notes-access-${rotations}`;
		const refresh = `notes-refresh-${rotations}`;
		this.ctx.storage.transactionSync(() => {
			sql.exec("UPDATE tokens SET valid = 0 WHERE kind = 'refresh'");
			sql.exec("INSERT INTO tokens (value, kind, valid) VALUES (?, 'access', 1), (?, 'refresh', 1)", access, refresh);
			sql.exec("UPDATE settings SET value = ? WHERE key = 'rotations'", String(rotations));
			// The new tokens belong to whoever the spent refresh token did.
			sql.exec("INSERT INTO owners (token, account_id, account_name) SELECT ?, account_id, account_name FROM owners WHERE token = ?", access, given);
			sql.exec("INSERT INTO owners (token, account_id, account_name) SELECT ?, account_id, account_name FROM owners WHERE token = ?", refresh, given);
		});
		return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer", scope: "notes" });
	}
	/** `authorization_code`: a code works once, for its client and redirect URI, with the verifier of its challenge. */
	async #redeem(form: URLSearchParams): Promise<Response> {
		const sql = this.#sql();
		const code = form.get("code") ?? "";
		const row = sql
			.exec<{ client_id: string; redirect_uri: string; challenge: string | null; scope: string; account_id: string; account_name: string }>(
				"UPDATE codes SET used = 1 WHERE code = ? AND used = 0 RETURNING client_id, redirect_uri, challenge, scope, account_id, account_name",
				code,
			)
			.toArray()[0];
		if (!row || row.client_id !== form.get("client_id") || row.redirect_uri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
		if (row.challenge !== null) {
			const verifier = form.get("code_verifier") ?? "";
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
			const computed = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
			if (!verifier || computed !== row.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
		}
		const access = `notes-access-${crypto.randomUUID()}`;
		const refresh = `notes-refresh-${crypto.randomUUID()}`;
		this.ctx.storage.transactionSync(() => {
			sql.exec("INSERT INTO tokens (value, kind, valid) VALUES (?, 'access', 1), (?, 'refresh', 1)", access, refresh);
			for (const token of [access, refresh]) sql.exec("INSERT INTO owners (token, account_id, account_name) VALUES (?, ?, ?)", token, row.account_id, row.account_name);
		});
		return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer", scope: row.scope });
	}
}
