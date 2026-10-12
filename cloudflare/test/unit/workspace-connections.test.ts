// Connections and access in the Workspace, over node:sqlite: saving connections and built-in services
// (connectors 11.6, 11.9), access settings and grant edits (connectors 4.5, 13; the access cases of
// backend/tests/test_api.py and test_contract.py), consent (11.7) and the Needs-reconnecting
// compare-and-set (9.2).

import { describe, expect, test } from "vitest";
import { resourceKey } from "../../src/gateway/grants.ts";
import { ALREADY_CONNECTED, NOT_FOUND, NOT_YOURS, UNKNOWN_PROVIDER } from "../../src/workspace/core.ts";
import { consentNeeded, requestedScopes } from "../../src/workspace/out.ts";
import { ADA, GRACE, OTHER, USER, accessOf, column, connectMixed, credentials, grant, harness, setCredentials } from "./workspace-support.ts";

const names = (...pairs: [string, string][]) => Object.fromEntries(pairs.map(([id, name]) => [resourceKey("folder", id), name]));

describe("saving connections", () => {
	test("a new account is the caller's, generation 1; the same account again updates it in place", async () => {
		const h = await harness();
		const id = await connectMixed(h, { access_token: "a1" });
		expect(column(h, id, "owner_id")).toBe(USER);
		expect(column(h, id, "generation")).toBe(1);
		await grant(h, id, { inbox: ["read"] });
		const again = await connectMixed(h, { access_token: "a2" });
		expect(again).toBe(id);
		expect(column(h, id, "generation")).toBe(2);
		expect((await credentials(h, id)).access_token).toBe("a2");
		// A fresh authorize of a connected account keeps its grants.
		expect(accessOf(await h.core.getAccess(ADA, id)).grants).toEqual([{ kind: "folder", id: "inbox", name: null, actions: ["read"] }]);
	});

	test("an account connected by someone else in the workspace is refused", async () => {
		const h = await harness();
		await connectMixed(h, {});
		await expect(connectMixed(h, {}, { caller: GRACE })).rejects.toThrow(ALREADY_CONNECTED);
	});

	test("a reconnect needs the same provider account, and a connection that still exists", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		const reconnect = (account: string, connectionId: string, provider = "mixed") =>
			h.core.saveConnection(ADA, {
				provider,
				account: { id: account, label: "Other" },
				credentials: provider === "keyed" ? { kind: "api_key", key: "k2" } : { kind: "oauth2", access_token: "b", refresh_token: null, scopes: null },
				connectionId,
			});
		expect(await reconnect("acct-2", id)).toEqual({
			ok: false,
			refusal: { status: 422, detail: "You signed in to a different Mixed account. Sign in as Fake account." },
		});
		const keyed = await h.core.saveConnection(ADA, { provider: "keyed", account: { id: "k-1", label: "Key account" }, credentials: { kind: "api_key", key: "k1" }, connectionId: null });
		if (!keyed.ok) throw new Error(keyed.refusal.detail);
		expect(await reconnect("k-2", keyed.value.id, "keyed")).toEqual({
			ok: false,
			refusal: { status: 422, detail: "This key is for a different Keyed account. Use a key for Key account." },
		});
		await h.core.deleteConnection(ADA, id);
		expect(await reconnect("acct-1", id)).toEqual({ ok: false, refusal: { status: 422, detail: "This Mixed connection was removed. Connect it again." } });
		expect(await h.core.saveConnection(ADA, { provider: "nope", account: { id: "x", label: "x" }, credentials: { kind: "builtin" }, connectionId: null })).toEqual({
			ok: false,
			refusal: { status: 404, detail: UNKNOWN_PROVIDER },
		});
	});

	test("a reconnect makes the connection active again with the next generation", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		h.sql.exec("UPDATE connections SET status = 'error'");
		await connectMixed(h, { access_token: "b" }, { connectionId: id });
		expect([column(h, id, "status"), column(h, id, "generation")]).toEqual(["active", 2]);
	});

	test("a shared connection is renewed only through its own flow, by an admin", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		h.sql.exec("UPDATE connections SET owner_id = NULL");
		// Without its id, the same account is someone else's.
		await expect(connectMixed(h, {})).rejects.toThrow(ALREADY_CONNECTED);
		const member = { userId: OTHER, role: "member" } as const;
		await expect(connectMixed(h, {}, { caller: member, connectionId: id })).rejects.toThrow("Only workspace admins can reconnect shared connections.");
		await connectMixed(h, {}, { caller: { userId: OTHER, role: "admin" }, connectionId: id });
		expect(column(h, id, "owner_id")).toBeNull();
		const listed = await h.core.listConnections(member);
		expect(listed.map((out) => [out.id, out.personal])).toEqual([[id, false]]);
	});

	test("someone else's personal connection cannot be renewed", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await expect(connectMixed(h, {}, { caller: GRACE, connectionId: id })).rejects.toThrow(NOT_YOURS);
	});

	test("reconnecting keeps a refresh token only from the same client (test_contract)", async () => {
		const h = await harness();
		const id = await connectMixed(h, { access_token: "a", refresh_token: "r1", client_id: "id" });
		const reconnect = async (clientId: string) => {
			await connectMixed(h, { access_token: "b", refresh_token: null, client_id: clientId, token_url: "https://mixed.example/token" });
			return credentials(h, id);
		};
		expect((await reconnect("id")).refresh_token).toBe("r1");
		expect((await reconnect("other")).refresh_token).toBeNull();
		// A kept refresh token still goes to the endpoint that issued it.
		await setCredentials(h, id, { kind: "oauth2", access_token: "a", refresh_token: "r1", client_id: "id", token_url: "https://old.mixed.example/token" });
		const kept = await reconnect("id");
		expect([kept.refresh_token, kept.token_url]).toEqual(["r1", "https://old.mixed.example/token"]);
		// Tokens saved before the issuer was recorded may come from another client.
		await setCredentials(h, id, { kind: "oauth2", access_token: "a", refresh_token: "r1" });
		expect((await reconnect("id")).refresh_token).toBeNull();
	});

	test("an API key is stored as {kind, key} under the account's label", async () => {
		const h = await harness();
		const saved = await h.core.saveConnection(ADA, { provider: "keyed", account: { id: "acct-1", label: "Fake account" }, credentials: { kind: "api_key", key: "secret-key" }, connectionId: null });
		if (!saved.ok) throw new Error(saved.refusal.detail);
		expect(saved.value).toMatchObject({ provider: "keyed", provider_name: "Keyed", auth: "api_key", label: "Fake account", status: "active", personal: true, consent_needed: [] });
		expect(await credentials(h, saved.value.id)).toEqual({ kind: "api_key", key: "secret-key" });
		expect(column(h, saved.value.id, "scopes")).toBeNull();
	});

	test("ciphertext is Fernet under the first key's version, and the plaintext is Python's json.dumps", async () => {
		const h = await harness();
		const id = await connectMixed(h, { access_token: "a1", scopes: ["files"] });
		expect(column(h, id, "key_version")).toBe("v1");
		const plaintext = new TextDecoder().decode(await h.keys.decryptBytes({ ciphertext: column(h, id, "ciphertext") as string, version: "v1" }));
		expect(plaintext).toBe('{"kind": "oauth2", "access_token": "a1", "refresh_token": null, "scopes": ["files"]}');
	});
});

describe("built-in services", () => {
	test("one per user, idempotent; nothing is allowed on it yet", async () => {
		const h = await harness();
		const first = await h.core.enableBuiltin(ADA, "webby");
		const again = await h.core.enableBuiltin(ADA, "webby");
		expect(first.ok && again.ok && first.value.id === again.value.id).toBe(true);
		expect(first.ok && first.value).toMatchObject({ provider: "webby", auth: "builtin", label: "Webby", allowed: [], consent_needed: [] });
		const graces = await h.core.enableBuiltin(GRACE, "webby");
		expect(graces.ok && first.ok && graces.value.id !== first.value.id).toBe(true);
		expect(await h.core.enableBuiltin(ADA, "mixed")).toEqual({ ok: false, refusal: { status: 422, detail: "Mixed is connected through its own sign-in." } });
		expect(await h.core.enableBuiltin(ADA, "nope")).toEqual({ ok: false, refusal: { status: 404, detail: UNKNOWN_PROVIDER } });
		expect(first.ok && (await credentials(h, first.value.id))).toEqual({ kind: "builtin" });
	});
});

describe("listing and removing connections", () => {
	test("the caller's own connections by creation, then the shared ones; never another user's", async () => {
		const h = await harness();
		const shared = await connectMixed(h, {}, { account: "shared" });
		h.sql.exec("UPDATE connections SET owner_id = NULL WHERE id = ?", shared);
		await h.timers.advance(1);
		const mine = await connectMixed(h, {}, { account: "mine" });
		await connectMixed(h, {}, { caller: GRACE, account: "theirs" });
		expect((await h.core.listConnections(ADA)).map((out) => out.id)).toEqual([mine, shared]);
	});

	test("removing: another user's is not found, a shared one needs an admin, grants go with it", async () => {
		const h = await harness();
		const theirs = await connectMixed(h, {}, { caller: GRACE, account: "theirs" });
		expect(await h.core.deleteConnection(ADA, theirs)).toEqual({ ok: false, refusal: { status: 404, detail: NOT_YOURS } });
		expect(await h.core.deleteConnection(ADA, "0199a000-0000-7000-8000-0000000000ff")).toEqual({ ok: false, refusal: { status: 404, detail: NOT_FOUND } });
		const shared = await connectMixed(h, {}, { account: "shared" });
		h.sql.exec("UPDATE connections SET owner_id = NULL WHERE id = ?", shared);
		expect(await h.core.deleteConnection({ userId: USER, role: "member" }, shared)).toEqual({
			ok: false,
			refusal: { status: 403, detail: "Only workspace admins can remove shared connections." },
		});
		await grant(h, shared, { inbox: ["read"] });
		expect(await h.core.deleteConnection(ADA, shared)).toEqual({ ok: true, value: { revocation: "acknowledged" } });
		expect(h.sql.exec("SELECT count(*) AS n FROM grants")).toEqual([{ n: 0 }]);
	});
});

describe("access settings", () => {
	test("access lists the kinds and actions, and the user's grants sorted", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		const access = accessOf(await h.core.getAccess(ADA, id));
		expect(access?.grants).toEqual([]);
		expect(access?.kinds).toEqual([
			{ id: "folder", label: "Folder", actions: ["read", "create"], wildcard: true, hierarchical: false, note: null, listed: true, browsable: false },
			{ id: "label", label: "Label", actions: ["read"], wildcard: false, hierarchical: false, note: null, listed: true, browsable: false },
		]);
		expect(access?.actions).toEqual([
			{ id: "read", label: "Read", requires: null },
			{ id: "create", label: "Create", requires: "read" },
		]);
		expect(h.server.calls).toEqual([]);
		expect(await h.core.getAccess(GRACE, id)).toEqual({ ok: false, refusal: { status: 404, detail: "Not found." } });
	});

	test("invalid changes are refused, all or nothing (test_api)", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		const bad: [{ kind: string; id: string; actions: string[] }[], string][] = [
			[[{ kind: "folder", id: "inbox", actions: ["create"] }], "Create on Inbox also requires Read."],
			[[{ kind: "folder", id: "inbox", actions: ["delete"] }], "Mixed does not support 'delete' on folder."],
			[[{ kind: "task", id: "inbox", actions: ["read"] }], "Mixed has no resources of type 'task'."],
			[
				[
					{ kind: "folder", id: "inbox", actions: ["read"] },
					{ kind: "folder", id: "inbox", actions: [] },
				],
				"Each resource can only be listed once.",
			],
			[[{ kind: "label", id: "*", actions: ["read"] }], "Permissions for label resources are set one at a time."],
			[[{ kind: "account", id: id, actions: ["read"] }], "Mixed has no resources of type 'account'."],
			[[], "Nothing to change."],
		];
		for (const [changes, detail] of bad) {
			expect(await h.core.applyGrantChanges(ADA, id, changes, names(["inbox", "Inbox"]))).toEqual({ ok: false, refusal: { status: 422, detail } });
		}
		expect(h.sql.exec("SELECT count(*) AS n FROM grants")).toEqual([{ n: 0 }]);
		expect(h.sql.exec("SELECT version FROM layers WHERE id = ?", `user:${USER}`)).toEqual([{ version: 1 }]);
		const saved = await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "inbox", actions: ["read", "create"] }], names(["inbox", "Inbox"]));
		expect(saved.ok && saved.value.access.grants).toEqual([{ kind: "folder", id: "inbox", name: "Inbox", actions: ["create", "read"] }]);
		expect(h.sql.exec("SELECT version FROM layers WHERE id = ?", `user:${USER}`)).toEqual([{ version: 2 }]);
		expect(await h.core.applyGrantChanges(GRACE, id, [{ kind: "folder", id: "inbox", actions: ["read"] }], {})).toEqual({ ok: false, refusal: { status: 404, detail: NOT_YOURS } });
	});

	test("wildcards: a requirement may rest on one, which then cannot be removed (test_contract)", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await grant(h, id, { "*": ["read"] });
		const saved = await grant(h, id, { archive: ["create"] });
		expect(saved.access.grants).toContainEqual({ kind: "folder", id: "archive", name: null, actions: ["create"] });
		expect(await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "*", actions: [] }], {})).toEqual({
			ok: false,
			refusal: { status: 422, detail: "Create on archive also requires Read." },
		});
		expect((await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "archive", actions: [] }], {})).ok).toBe(true);
		expect((await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "*", actions: [] }], {})).ok).toBe(true);
	});

	test("the summary of what the user allows (test_api)", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		expect((await h.core.listConnections(ADA))[0]?.allowed).toEqual([]);
		await h.core.applyGrantChanges(
			ADA,
			id,
			[
				{ kind: "folder", id: "*", actions: ["read"] },
				{ kind: "folder", id: "inbox", actions: ["read", "create"] },
			],
			names(["inbox", "Inbox"]),
		);
		expect((await h.core.listConnections(ADA))[0]?.allowed).toEqual([
			{ kind: "folder", kind_label: "Folder", action: "read", action_label: "Read", all: true, count: 1, names: ["Inbox"] },
			{ kind: "folder", kind_label: "Folder", action: "create", action_label: "Create", all: false, count: 1, names: ["Inbox"] },
		]);
		// Another user's summary of a shared connection is their own.
		h.sql.exec("UPDATE connections SET owner_id = NULL");
		expect((await h.core.listConnections(GRACE))[0]?.allowed).toEqual([]);
	});

	test("a connection has at most 500 grants (test_contract)", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		for (let i = 0; i < 500; i++) {
			h.sql.exec("INSERT INTO grants (layer_id, connection_id, kind, resource_id, actions, effect) VALUES (?, ?, 'folder', ?, '[\"read\"]', 'allow')", `user:${USER}`, id, `f${i}`);
		}
		const add = () => h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "inbox", actions: ["read"] }], names(["inbox", "Inbox"]));
		expect(await add()).toEqual({ ok: false, refusal: { status: 422, detail: "A connection can have at most 500 permissions." } });
		expect((await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "f0", actions: [] }], {})).ok).toBe(true);
		expect((await add()).ok).toBe(true);
	});

	test("account grants are named with the connection's label, without the provider (test_contract)", async () => {
		const h = await harness();
		const saved = await h.core.saveConnection(ADA, { provider: "keyed", account: { id: "acct-1", label: "Fake account" }, credentials: { kind: "api_key", key: "secret-key" }, connectionId: null });
		if (!saved.ok) throw new Error(saved.refusal.detail);
		const id = saved.value.id;
		expect(await h.core.applyGrantChanges(ADA, id, [{ kind: "account", id: "someone-else", actions: ["read"] }], {})).toEqual({
			ok: false,
			refusal: { status: 422, detail: "Account permissions apply to the connection itself." },
		});
		const granted = await h.core.applyGrantChanges(ADA, id, [{ kind: "account", id, actions: ["read"] }], {});
		expect(granted.ok && granted.value.access.grants).toEqual([{ kind: "account", id, name: "Fake account", actions: ["read"] }]);
		expect(h.server.calls).toEqual([]);
	});

	test("provider names are kept to 300 characters and lone surrogates replaced", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await h.core.applyGrantChanges(ADA, id, [{ kind: "folder", id: "inbox", actions: ["read"] }], names(["inbox", `\ud800${"é".repeat(400)}`]));
		const [row] = h.sql.exec<{ resource_name: string }>("SELECT resource_name FROM grants");
		expect([...(row?.resource_name ?? "")].length).toBe(300);
		expect(row?.resource_name.startsWith("�")).toBe(true);
	});

	test("the actions allowed: the caller's, or every member's on a shared connection", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await grant(h, id, { inbox: ["read", "create"] });
		expect(await h.core.allowedActions(ADA, id)).toEqual(["create", "read"]);
		expect(await h.core.allowedActions(GRACE, id)).toBeNull();
		h.sql.exec("UPDATE connections SET owner_id = NULL");
		expect(await h.core.allowedActions(GRACE, id)).toEqual(["create", "read"]);
	});
});

describe("consent", () => {
	test("consent_needed lists allowed actions whose scopes are missing; unknown scopes need nothing", async () => {
		const h = await harness();
		const mixed = h.registry.get("mixed");
		expect(consentNeeded(mixed, ["files"], new Set(["read"]))).toEqual(["read"]);
		expect(consentNeeded(mixed, ["files", "labels"], new Set(["read"]))).toEqual([]);
		expect(consentNeeded(mixed, null, new Set(["read"]))).toEqual([]);
		// Known but none: everything with consent is blamed.
		expect(consentNeeded(mixed, [], new Set(["read", "create"]))).toEqual(["read"]);
		expect(consentNeeded(h.registry.get("keyed"), [], new Set(["read"]))).toEqual([]);
		expect(requestedScopes(mixed, new Set(["read"]))).toEqual(["files", "labels"]);
		const id = await connectMixed(h, { scopes: ["files"] });
		await h.core.applyGrantChanges(ADA, id, [{ kind: "label", id: "red", actions: ["read"] }], {});
		expect((await h.core.listConnections(ADA))[0]?.consent_needed).toEqual(["read"]);
	});
});

describe("Needs reconnecting", () => {
	test("marked only while active at the generation the failed call used", async () => {
		const h = await harness();
		const id = await connectMixed(h, {});
		await h.core.markUnauthorized(id, 2);
		expect(column(h, id, "status")).toBe("active");
		await h.core.markUnauthorized(id, 1);
		expect(column(h, id, "status")).toBe("error");
		// New credentials are the next generation: a rejection seen with the old ones does not mark them.
		await connectMixed(h, {}, { connectionId: id });
		await h.core.markUnauthorized(id, 1);
		expect([column(h, id, "status"), column(h, id, "generation")]).toEqual(["active", 2]);
		expect((await h.core.listConnections(ADA))[0]?.status).toBe("active");
	});
});
