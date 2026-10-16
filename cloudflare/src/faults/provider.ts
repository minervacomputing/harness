// The fake provider of the test build (src/faults/): the Notes API, as a Durable Object per workspace, so what it applied
// survives the crashes of the objects that call it. It records every request with the time it arrived, accepts only the
// access token it was set up with, and can hold its answers to a path for a while, to keep a request in flight. Reached only
// through the test build's network port (ports.ts), never from outside the Worker.
//
// An object of its own per workspace (ports.ts, `modelScope`) answers the `fake-remote` model's requests, at FAKE_MODEL_HOST:
// an empty 204 after its delay, recording nothing, so their round trip waits on no write and no fake Laravel traffic.
//
// It also hosts the workspace's fake Laravel (laravel.ts), at LARAVEL_HOST, in tables of its own; its requests are not in the
// Notes request log. Its points, `laravel:<operation>` (`leaseToken`, `reportUnauthorized`, `deliverFacts`), fire once the
// operation has written its rows, before its answer leaves (`abort` or `note`).

import { DurableObject } from "cloudflare:workers";
import { laravel } from "@minerva/contract/internal";
import { settings } from "../config.ts";
import { type Json, parseJson } from "../lib/json.ts";
import { type FakeConnection, type FakeRun, LARAVEL_SCHEMA, LARAVEL_TABLES, type LaravelView, SqlLaravel, hostedToken } from "./laravel.ts";
import { type Fault, type Fired, planOf } from "./plan.ts";
import { FAKE_MODEL_HOST, LARAVEL_HOST } from "./settings.ts";

export interface ProviderSetup {
	folders?: { id: string; name: string; notes?: string[] }[];
	/** The access token the connection holds. */
	access?: string;
	/** Milliseconds to hold answers to requests whose "METHOD /path" starts with a key. */
	delays?: { [prefix: string]: number };
}

export interface ProviderRequestLog {
	seq: number;
	at: number;
	method: string;
	path: string;
	/** The fake bearer token it carried, or "". */
	token: string;
	status: number;
}

export interface ProviderState {
	notes: { id: number; folder: string; title: string }[];
	requests: ProviderRequestLog[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, title TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS tokens (value TEXT PRIMARY KEY, kind TEXT NOT NULL, valid INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS requests (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, token TEXT NOT NULL, status INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

/** The account the fake provider's token belongs to (`/me`). */
const NOTES_ACCOUNT = { id: "notes-account-1", name: "Notes account" };

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

	/** Starts over: folders and their notes, the connection's token, delays; the request log, the fake Laravel and the plan are cleared. */
	reset(setup: ProviderSetup = {}): void {
		const sql = this.#sql();
		planOf(this.ctx).set([]);
		this.ctx.storage.transactionSync(() => {
			for (const table of ["folders", "notes", "tokens", "requests", "settings", ...LARAVEL_TABLES]) sql.exec(`DELETE FROM ${table}`);
			for (const folder of setup.folders ?? DEFAULT_FOLDERS) {
				sql.exec("INSERT INTO folders (id, name) VALUES (?, ?)", folder.id, folder.name);
				for (const title of folder.notes ?? []) sql.exec("INSERT INTO notes (folder, title) VALUES (?, ?)", folder.id, title);
			}
			sql.exec("INSERT INTO tokens (value, kind, valid) VALUES (?, 'access', 1)", setup.access ?? "notes-access-0");
			sql.exec("INSERT INTO settings (key, value) VALUES ('delays', ?)", JSON.stringify(setup.delays ?? {}));
		});
	}

	setDelays(delays: { [prefix: string]: number }): void {
		this.#sql().exec("INSERT INTO settings (key, value) VALUES ('delays', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(delays));
	}

	state(): ProviderState {
		const sql = this.#sql();
		return {
			notes: sql.exec<{ id: number; folder: string; title: string }>("SELECT id, folder, title FROM notes ORDER BY id").toArray(),
			requests: sql.exec<{ seq: number; at: number; method: string; path: string; token: string; status: number }>("SELECT * FROM requests ORDER BY seq").toArray(),
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
		const key = `${request.method} ${url.pathname}`;
		const delays = parseJson(this.#setting("delays") ?? "{}") as { [prefix: string]: number };
		const delay = Object.entries(delays).find(([prefix]) => key.startsWith(prefix))?.[1] ?? 0;
		if (url.hostname === FAKE_MODEL_HOST) {
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			return new Response(null, { status: 204 });
		}
		const at = Date.now();
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
		const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		const known = sql.exec("SELECT 1 FROM tokens WHERE kind = 'access' AND valid = 1 AND value = ?", bearer).toArray().length > 0;
		if (!known) return json(401, { error: "invalid_token" });
		if (request.method === "GET" && url.pathname === "/me") return json(200, NOTES_ACCOUNT);
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
}
