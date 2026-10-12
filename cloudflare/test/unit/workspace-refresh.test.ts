// Credential leases and refresh (plan: Credentials and refresh; connectors 9.3, 11.1, 11.4, 11.5), over
// node:sqlite with a fake token endpoint: backend/tests/test_connections.py and the refresh cases of
// test_contract.py, the refusal codes, the single flight, and the fault cases: a crash during a rotating
// refresh (restart while `refreshing`) and a reconnect or delete during one.

import { describe, expect, test } from "vitest";
import type { CredentialLease } from "../../src/contracts/executor.ts";
import type { JsonObject } from "../../src/lib/json.ts";
import { RUN_ENDED } from "../../src/workspace/core.ts";
import { EXPIRED, type OAuth2, keepRefreshToken, parseScopes, tokenPayload, tokenRequest } from "../../src/workspace/credentials.ts";
import {
	ADA,
	GRACE,
	RotatingProvider,
	attach,
	begin,
	binding,
	column,
	connectMixed,
	credentials,
	defaultAgent,
	grant,
	harness,
	running,
	setCredentials,
	settle,
	tokens,
	type Harness,
} from "./workspace-support.ts";

const SETTINGS = { settings: ADA } as const;

/** An OAuth connection whose access token expires now. */
async function expiring(h: Harness, payload: JsonObject = {}): Promise<string> {
	const id = await connectMixed(h, {});
	await setCredentials(h, id, { kind: "oauth2", access_token: "old", refresh_token: "r1", expires_at: Math.floor(h.timers.now() / 1000), ...payload });
	return id;
}

async function lent(h: Harness, id: string, purpose: Parameters<Harness["core"]["lease"]>[1] = SETTINGS): Promise<CredentialLease> {
	const lease = await h.core.lease(id, purpose);
	if ("refused" in lease) throw new Error(`${lease.refused}: ${lease.message}`);
	return lease;
}

async function accessToken(h: Harness, lease: CredentialLease): Promise<unknown> {
	return ((await h.keys.decrypt(binding(lease.connectionId), lease.sealed)) as JsonObject).access_token;
}

describe("leases", () => {
	test("a token with more than 120 s left is lent as stored, with its scopes and generation", async () => {
		const h = await harness();
		const id = await connectMixed(h, { access_token: "a1", scopes: ["labels", "files"], expires_at: Math.floor(h.timers.now() / 1000) + 121 });
		const lease = await lent(h, id);
		expect(lease).toMatchObject({ connectionId: id, provider: "mixed", generation: 1, scopes: ["files", "labels"] });
		expect(await accessToken(h, lease)).toBe("a1");
		expect(h.endpoint.sent).toEqual([]);
		// Tokens without an expiry are never refreshed; unknown scopes are null.
		const keyed = await h.core.saveConnection(ADA, { provider: "keyed", account: { id: "k", label: "K" }, credentials: { kind: "api_key", key: "k" }, connectionId: null });
		expect(keyed.ok && (await lent(h, keyed.value.id)).scopes).toBeNull();
	});

	test("a connection that is not active, missing or someone else's is refused as expired", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		expect(await h.core.lease(id, { settings: GRACE })).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		h.sql.exec("UPDATE connections SET status = 'error'");
		expect(await h.core.lease(id, SETTINGS)).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: "The connection expired. Reconnect it in Minerva." });
		expect(await h.core.lease("0199a000-0000-7000-8000-0000000000ff", SETTINGS)).toMatchObject({ refused: "CONNECTION_UNAUTHORIZED" });
	});

	test("a run's lease needs the run registered, activated, not revoked, the user's, and one of its connections", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		const agent = await defaultAgent(h);
		await attach(h, agent, [id]);
		await grant(h, id, { inbox: ["read"] });
		const { input } = await running(h);
		const purpose = { run: input.runId, userId: input.userId };
		expect((await lent(h, id, purpose)).connectionId).toBe(id);
		expect(await h.core.lease(id, { run: input.runId, userId: GRACE.userId })).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED });
		expect(await h.core.lease(id, { run: "0199a000-0000-7000-8000-0000000000ff", userId: input.userId })).toMatchObject({ refused: "RUN_ENDED" });
		const other = await connectMixed(h, {}, { account: "acct-2" });
		expect(await h.core.lease(other, purpose)).toMatchObject({ refused: "CONNECTION_UNAUTHORIZED" });
		await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		expect(await h.core.lease(id, purpose)).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED });
	});

	test("a run that is registered but not yet activated cannot lease", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await attach(h, await defaultAgent(h), [id]);
		await grant(h, id, { inbox: ["read"] });
		const { input } = await begin(h);
		expect(await h.core.lease(id, { run: input.runId, userId: input.userId })).toMatchObject({ refused: "RUN_ENDED" });
		await h.core.activate(input.runId);
		expect((await lent(h, id, { run: input.runId, userId: input.userId })).connectionId).toBe(id);
		await h.core.release(input.runId, "completed");
		expect(await h.core.lease(id, { run: input.runId, userId: input.userId })).toMatchObject({ refused: "RUN_ENDED" });
	});
});

describe("refresh (test_connections, test_contract)", () => {
	test("keeps the refresh token when the provider omits it", async () => {
		const h = await harness();
		// A payload saved before `kind` was recorded is read as OAuth.
		const id = await connectMixed(h, {});
		await setCredentials(h, id, { access_token: "old", refresh_token: "r1", expires_at: Math.floor(h.timers.now() / 1000) });
		h.endpoint.responses.push(tokens({ access_token: "new", expires_in: 3600 }));
		expect(await accessToken(h, await lent(h, id))).toBe("new");
		expect((await credentials(h, id)).refresh_token).toBe("r1");
	});

	test("stores a rotated refresh token", async () => {
		const h = await harness();
		const id = await expiring(h);
		h.endpoint.responses.push(tokens({ access_token: "new", refresh_token: "r2", expires_in: 3600 }));
		await lent(h, id);
		expect((await credentials(h, id)).refresh_token).toBe("r2");
	});

	test("keeps scopes unless the provider names them, and records the client", async () => {
		const h = await harness();
		const id = await expiring(h, { scopes: ["files", "labels"], client_id: "id" });
		h.endpoint.responses.push(tokens({ access_token: "a2", expires_in: 3600 }));
		expect((await lent(h, id)).scopes).toEqual(["files", "labels"]);
		expect((await credentials(h, id)).client_id).toBe("id");
		await setCredentials(h, id, { kind: "oauth2", access_token: "old", refresh_token: "r1", expires_at: 0, scopes: ["files", "labels"] });
		h.endpoint.responses.push(tokens({ access_token: "a3", expires_in: 3600, scope: "files" }));
		expect((await lent(h, id)).scopes).toEqual(["files"]);
		// GitHub separates scopes with commas.
		await setCredentials(h, id, { kind: "oauth2", access_token: "old", refresh_token: "r1", expires_at: 0 });
		h.endpoint.responses.push(tokens({ access_token: "a4", expires_in: 3600, scope: "files,labels" }));
		expect((await lent(h, id)).scopes).toEqual(["files", "labels"]);
	});

	test("goes to the endpoint that issued the tokens, and records it", async () => {
		const h = await harness();
		const id = await expiring(h, { client_id: "id", token_url: "https://old.mixed.example/token" });
		h.endpoint.responses.push(tokens({ access_token: "a2", expires_in: 60 }), tokens({ access_token: "a3", expires_in: 60 }));
		// A token that expires soon again is still lent once refreshed: one refresh per lease.
		expect(await accessToken(h, await lent(h, id))).toBe("a2");
		expect(h.endpoint.sent.map((sent) => sent.url)).toEqual(["https://old.mixed.example/token"]);
		expect((await credentials(h, id)).token_url).toBe("https://old.mixed.example/token");
		// Tokens saved before the endpoint was recorded use the declared one.
		await setCredentials(h, id, { kind: "oauth2", access_token: "old", refresh_token: "r1", expires_at: 0, client_id: "id" });
		await lent(h, id);
		expect(h.endpoint.sent[1]?.url).toBe("https://mixed.example/token");
		expect((await credentials(h, id)).token_url).toBe("https://mixed.example/token");
	});

	test("needs the client that issued the tokens: a retired one leaves the connection needing reconnecting", async () => {
		const h = await harness();
		const id = await expiring(h, { client_id: "retired" });
		expect(await h.core.lease(id, SETTINGS)).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		expect(column(h, id, "status")).toBe("error");
		expect(h.endpoint.sent).toEqual([]);
		expect(h.logs.map((log) => log.message)).toContain("The OAuth client that issued a connection is no longer configured");
	});

	test("a dynamically registered client issues and refreshes too", async () => {
		const h = await harness();
		h.oauth.clients.clear();
		h.oauth.registered.set("mixed http://localhost/api/oauth/mixed/callback", { clientId: "dcr", clientSecret: "s", redirectUri: "http://localhost/api/oauth/mixed/callback" });
		const id = await expiring(h, { client_id: "dcr" });
		h.endpoint.responses.push(tokens({ access_token: "a2", expires_in: 3600 }));
		await lent(h, id);
		expect(h.endpoint.sent[0]?.fields).toEqual({ client_id: "dcr", client_secret: "s", grant_type: "refresh_token", refresh_token: "r1" });
	});

	test("the token request: a form, the client first, JSON accepted, never redirected", async () => {
		const h = await harness();
		const id = await expiring(h, { client_id: "id" });
		h.endpoint.responses.push(tokens({ access_token: "a2", expires_in: 3600 }));
		await lent(h, id);
		const [sent] = h.endpoint.sent;
		expect(sent?.method).toBe("POST");
		expect(sent?.headers.accept).toBe("application/json");
		expect(sent?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
		expect(sent?.body).toBe("client_id=id&client_secret=secret&grant_type=refresh_token&refresh_token=r1");
		const oauth: OAuth2 = { type: "oauth2", app: "x", authorizeUrl: "https://x.example/a", tokenUrl: "https://x.example/t", scopes: [] };
		const creds = { clientId: "ïd", clientSecret: "s:t", redirectUri: "https://x/cb" };
		expect(tokenRequest(oauth, creds, [["grant_type", "refresh_token"]]).redirect).toBe("manual");
		const basic = tokenRequest({ ...oauth, clientAuth: "basic", jsonBody: true }, creds, [["grant_type", "refresh_token"]]);
		expect(basic.headers).toMatchObject({ Authorization: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode("ïd:s:t")))}`, "Content-Type": "application/json" });
		expect(basic.body).toBe('{"grant_type":"refresh_token"}');
	});

	test("refusals: which mean Needs reconnecting, and which leave the connection as it is", async () => {
		const cases: [Response | Error, "error" | "active", string | null][] = [
			[tokens({ error: "invalid_grant" }, 400), "error", EXPIRED],
			[tokens({}, 401), "error", EXPIRED],
			[tokens({ error: "invalid_grant" }, 403), "error", EXPIRED],
			[tokens({ error: "forbidden" }, 403), "active", "Mixed could not refresh the connection."],
			[tokens({}, 500), "active", "Mixed could not refresh the connection."],
			[tokens({ error: "bad_refresh_token" }), "error", EXPIRED],
			[tokens({ error: "invalid_refresh_token" }), "error", EXPIRED],
			[tokens({ error: "invalid_client" }), "active", "Mixed could not refresh the connection."],
			[new Response("not json", { status: 200 }), "active", "Mixed could not refresh the connection."],
			[new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/token" } }), "active", "Mixed could not refresh the connection."],
			[new TypeError("fetch failed"), "active", "Mixed could not be reached."],
		];
		for (const [response, status, message] of cases) {
			const h = await harness();
			const id = await expiring(h, { client_id: "id" });
			h.endpoint.responses.push(response);
			const lease = await h.core.lease(id, SETTINGS);
			expect(lease, String(message)).toEqual({ refused: status === "error" ? "CONNECTION_UNAUTHORIZED" : "PROVIDER_UNAVAILABLE", message });
			expect(column(h, id, "status")).toBe(status);
			expect(column(h, id, "generation")).toBe(2);
		}
	});

	test("no refresh token means Needs reconnecting, without asking the provider", async () => {
		const h = await harness();
		const id = await expiring(h, { refresh_token: null });
		expect(await h.core.lease(id, SETTINGS)).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		expect([column(h, id, "status"), h.endpoint.sent.length]).toEqual(["error", 0]);
	});

	test("a refresh is the next generation, so a rejection seen with the old token does not mark the new one", async () => {
		const h = await harness();
		const id = await expiring(h);
		h.endpoint.responses.push(tokens({ access_token: "a2", expires_in: 3600 }));
		const lease = await lent(h, id);
		expect(lease.generation).toBe(3);
		await h.core.markUnauthorized(id, 2);
		expect(column(h, id, "status")).toBe("active");
	});
});

describe("single flight", () => {
	test("concurrent leases share one refresh and see its tokens", async () => {
		const h = await harness();
		const id = await expiring(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const leases = [h.core.lease(id, SETTINGS), h.core.lease(id, SETTINGS), h.core.lease(id, SETTINGS)];
		await settle();
		expect(h.endpoint.sent).toHaveLength(1);
		for (const release of provider.held) release();
		const answers = await Promise.all(leases);
		expect(answers.map((lease) => "generation" in lease && lease.generation)).toEqual([3, 3, 3]);
		expect(provider.spent).toEqual(["r1"]);
		expect((await credentials(h, id)).refresh_token).toBe("r2");
	});
});

describe("faults", () => {
	test("a crash during a rotating refresh: the next use makes exactly one refresh with the stored token", async () => {
		const h = await harness();
		const id = await expiring(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const dying = h.core.lease(id, SETTINGS);
		await settle();
		// The provider rotated r1 into r2, but its answer never reaches the instance, which dies.
		expect(provider.spent).toEqual(["r1"]);
		expect(column(h, id, "refresh_state")).toBe("refreshing");
		h.restart();
		expect([column(h, id, "refresh_state"), column(h, id, "status")]).toEqual(["refresh_uncertain", "active"]);
		provider.hold = false;
		// While uncertain, nothing else uses the connection: both wait for the one refresh, which the provider
		// refuses because r1 was spent, so the connection needs reconnecting.
		const [first, second] = await Promise.all([h.core.lease(id, SETTINGS), h.core.lease(id, SETTINGS)]);
		expect(first).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		expect(second).toEqual(first);
		expect(h.endpoint.sent.map((sent) => sent.fields.refresh_token)).toEqual(["r1", "r1"]);
		expect([column(h, id, "status"), column(h, id, "refresh_state")]).toEqual(["error", "fresh"]);
		// The dead instance's late answer changes nothing.
		for (const release of provider.held) release();
		expect(await dying).toMatchObject({ refused: "CONNECTION_UNAUTHORIZED" });
		expect([column(h, id, "status"), column(h, id, "generation")]).toEqual(["error", 2]);
	});

	test("a crash after recording, before the provider heard: the one refresh succeeds and all is normal again", async () => {
		const h = await harness();
		const id = await expiring(h, { expires_at: Math.floor(h.timers.now() / 1000) + 3600 });
		h.sql.exec("UPDATE connections SET refresh_state = 'refreshing', refresh_generation = generation WHERE id = ?", id);
		h.restart();
		expect(column(h, id, "refresh_state")).toBe("refresh_uncertain");
		const provider = new RotatingProvider();
		h.endpoint.answer = (sent) => provider.answer(sent);
		// Even with an hour left, an uncertain connection refreshes before anything uses it.
		const lease = await lent(h, id);
		expect(await accessToken(h, lease)).toBe("a2");
		expect([column(h, id, "refresh_state"), column(h, id, "generation"), provider.spent]).toEqual(["fresh", 3, ["r1"]]);
		expect(await accessToken(h, await lent(h, id))).toBe("a2");
		expect(h.endpoint.sent).toHaveLength(1);
	});

	test("a transport error leaves the outcome unknown: the next use refreshes once more before anything else", async () => {
		const h = await harness();
		const id = await expiring(h, { expires_at: Math.floor(h.timers.now() / 1000) + 60 });
		h.endpoint.responses.push(new TypeError("connection reset"), tokens({ access_token: "a2", expires_in: 3600 }));
		expect(await h.core.lease(id, SETTINGS)).toEqual({ refused: "PROVIDER_UNAVAILABLE", message: "Mixed could not be reached." });
		expect([column(h, id, "status"), column(h, id, "refresh_state")]).toEqual(["active", "refresh_uncertain"]);
		expect(await accessToken(h, await lent(h, id))).toBe("a2");
		expect(column(h, id, "refresh_state")).toBe("fresh");
	});

	test("new credentials written during a refresh win: the refresh's result is dropped", async () => {
		const h = await harness();
		const id = await expiring(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const lease = h.core.lease(id, SETTINGS);
		await settle();
		expect(column(h, id, "refresh_state")).toBe("refreshing");
		// A reconnect that committed while the refresh's request was out (one that started before the refresh
		// did): the next generation, fresh.
		await setCredentials(h, id, { kind: "oauth2", access_token: "reconnected", refresh_token: "fresh-r", expires_at: Math.floor(h.timers.now() / 1000) + 3600 });
		for (const release of provider.held) release();
		const answer = await lease;
		expect("generation" in answer && answer.generation).toBe(3);
		expect(await accessToken(h, answer as CredentialLease)).toBe("reconnected");
		expect(await credentials(h, id)).toMatchObject({ access_token: "reconnected", refresh_token: "fresh-r" });
		expect([column(h, id, "generation"), column(h, id, "refresh_state")]).toEqual([3, "fresh"]);
	});

	test("a reconnect during a refresh waits for it, so a kept refresh token is the rotated one", async () => {
		const h = await harness();
		const id = await expiring(h, { client_id: "id" });
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const lease = h.core.lease(id, SETTINGS);
		await settle();
		// The provider omits the refresh token on reconnect; the same client issued both.
		const reconnect = connectMixed(h, { access_token: "reconnected", refresh_token: null, client_id: "id" }, { connectionId: id });
		await settle();
		expect(column(h, id, "generation")).toBe(2);
		for (const release of provider.held) release();
		await reconnect;
		expect("generation" in (await lease)).toBe(true);
		// r1 was spent by the refresh; the reconnect keeps r2, which the refresh stored.
		expect(await credentials(h, id)).toMatchObject({ access_token: "reconnected", refresh_token: "r2" });
		expect([column(h, id, "generation"), column(h, id, "refresh_state")]).toEqual([4, "fresh"]);
		expect(provider.spent).toEqual(["r1"]);
	});

	test("a refresh that starts while a reconnect is under way: the token kept is still valid at the provider", async () => {
		const h = await harness();
		const id = await expiring(h, { client_id: "id" });
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		// The reconnect passes its check for a refresh in flight first; the refresh starts during its awaits.
		const reconnect = connectMixed(h, { access_token: "reconnected", refresh_token: null, client_id: "id" }, { connectionId: id });
		const lease = h.core.lease(id, SETTINGS);
		let done = false;
		void Promise.all([reconnect, lease]).finally(() => {
			done = true;
		});
		for (let i = 0; i < 50 && !done; i++) {
			await settle();
			for (const release of provider.held.splice(0)) release();
		}
		expect(done).toBe(true);
		const stored = await credentials(h, id);
		expect(stored.access_token).toBe("reconnected");
		// Whichever came first, the refresh token kept was not spent.
		expect(stored.refresh_token).toBe(provider.current);
	});

	test("a rejection of the old token during a refresh does not mark the refreshed credentials", async () => {
		const h = await harness();
		const id = await expiring(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const lease = h.core.lease(id, SETTINGS);
		await settle();
		// An earlier call, made with generation 2, was rejected by the provider while the refresh is out.
		const marked = h.core.markUnauthorized(id, 2);
		await settle();
		expect(column(h, id, "status")).toBe("active");
		for (const release of provider.held) release();
		await marked;
		expect(await accessToken(h, (await lease) as CredentialLease)).toBe("a2");
		expect([column(h, id, "status"), column(h, id, "generation")]).toEqual(["active", 3]);
	});

	test("a delete during a refresh wins: nothing is written back", async () => {
		const h = await harness();
		const id = await expiring(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const lease = h.core.lease(id, SETTINGS);
		await settle();
		await h.core.deleteConnection(ADA, id);
		for (const release of provider.held) release();
		expect(await lease).toEqual({ refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED });
		expect(h.sql.exec("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
	});

	test("a run revoked during a refresh gets no lease", async () => {
		const h = await harness();
		const id = await expiring(h);
		await attach(h, await defaultAgent(h), [id]);
		await grant(h, id, { inbox: ["read"] });
		const { input } = await running(h);
		const provider = new RotatingProvider();
		provider.hold = true;
		h.endpoint.answer = (sent) => provider.answer(sent);
		const lease = h.core.lease(id, { run: input.runId, userId: input.userId });
		await settle();
		await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "archive", actions: ["read"] }], {});
		for (const release of provider.held) release();
		expect(await lease).toEqual({ refused: "RUN_ENDED", message: RUN_ENDED });
		// The refresh itself was stored: the provider rotated, and the next lease must use r2.
		expect((await credentials(h, id)).refresh_token).toBe("r2");
	});
});

describe("token bodies", () => {
	const now = Date.UTC(2026, 9, 12, 0, 0, 0);

	test("expires_at only from an integer expires_in under a year", () => {
		const seconds = now / 1000;
		expect(tokenPayload({ access_token: "a", expires_in: 3600 }, now)).toEqual({ kind: "oauth2", access_token: "a", refresh_token: null, scopes: null, expires_at: seconds + 3600 });
		expect(tokenPayload({ access_token: "a", expires_in: 3600.5 }, now)).not.toHaveProperty("expires_at");
		expect(tokenPayload({ access_token: "a", expires_in: 365 * 24 * 3600 }, now)).not.toHaveProperty("expires_at");
		expect(tokenPayload({ access_token: "a", expires_in: "3600" }, now)).not.toHaveProperty("expires_at");
		// A bool is an int in Python.
		expect(tokenPayload({ access_token: "a", expires_in: true }, now).expires_at).toBe(seconds + 1);
		expect(tokenPayload({ access_token: "a", refresh_token: "r" }, now).refresh_token).toBe("r");
	});

	test("scopes from `scope` or `scopes`, a list or a string, commas and whitespace, sorted and unique (Linear)", () => {
		expect(parseScopes({ scope: ["read", "write"] })).toEqual(["read", "write"]);
		expect(parseScopes({ scope: "read,issues:create" })).toEqual(["issues:create", "read"]);
		expect(parseScopes({ scope: " b  a,a\u001fc " })).toEqual(["a", "b", "c"]);
		expect(parseScopes({ scopes: ["crm.objects.contacts.read"] })).toEqual(["crm.objects.contacts.read"]);
		expect(parseScopes({ scope: null, scopes: "ignored" })).toBeNull();
		expect(parseScopes({ scope: ["read", 1] })).toBeNull();
		expect(parseScopes({})).toBeNull();
		expect(parseScopes({ scope: "" })).toEqual([]);
	});

	test("keep_refresh_token: only without a new one, from the same recorded client, with its endpoint", () => {
		const previous = { kind: "oauth2", access_token: "a", refresh_token: "r1", client_id: "id", token_url: "https://old.example/t" };
		expect(keepRefreshToken(previous, { kind: "oauth2", access_token: "b", refresh_token: null, client_id: "id" })).toMatchObject({ refresh_token: "r1", token_url: "https://old.example/t" });
		expect(keepRefreshToken(previous, { kind: "oauth2", access_token: "b", refresh_token: "r2", client_id: "id" }).refresh_token).toBe("r2");
		expect(keepRefreshToken(previous, { kind: "oauth2", access_token: "b", refresh_token: null, client_id: "other" }).refresh_token).toBeNull();
		expect(keepRefreshToken({ ...previous, client_id: null }, { kind: "oauth2", access_token: "b", refresh_token: null, client_id: null }).refresh_token).toBeNull();
		expect(keepRefreshToken(previous, { kind: "api_key", key: "k" })).toEqual({ kind: "api_key", key: "k" });
		expect(keepRefreshToken({ kind: "oauth2", access_token: "a", refresh_token: "r1", client_id: "id" }, { kind: "oauth2", access_token: "b", refresh_token: "", client_id: "id" })).toMatchObject({
			refresh_token: "r1",
			token_url: null,
		});
	});
});
