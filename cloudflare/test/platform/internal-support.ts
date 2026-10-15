// What the internal API's platform tests share: Laravel's calls behind an Access assertion they sign themselves, with the
// key set the Worker checks it against (vitest.platform.config.ts turns the internal API on with this issuer); the starts
// they send, a Notes world's among them (src/faults/world.ts); and the run's object and its view.

import { env, exports } from "cloudflare:workers";
import { type Scope, type StartRun, engine } from "@minerva/contract/internal";
import { ORPCError, createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll } from "vitest";
import { conversationObject } from "../../src/addressing.ts";
import type { Conversation, RunView } from "../../src/faults/index.ts";
import type { FakeLaravel } from "../../src/faults/laravel.ts";
import { heldRun, notesConnection, notesLayers } from "../../src/faults/world.ts";
import { ACCESS_KEYS, ASSERTION_HEADER } from "../../src/internal/access.ts";
import { uuid7 } from "../../src/lib/random.ts";

export const ISSUER = "https://test.cloudflareaccess.example";
export const AUDIENCE = "test-audience";
export const ORIGIN = "https://engine.example";

let key: CryptoKey;

/** Has the Worker check assertions against a key set of the test's own, for the file's tests. */
export function signedAssertions(): void {
	const published = ACCESS_KEYS.of;
	beforeAll(async () => {
		const pair = await generateKeyPair("RS256");
		key = pair.privateKey;
		const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
		ACCESS_KEYS.of = () => createLocalJWKSet({ keys: [jwk] });
	});
	afterAll(() => {
		ACCESS_KEYS.of = published;
	});
}

/** What Access adds once it has checked a service token. */
export function assertion(client = "laravel.access", audience = AUDIENCE): Promise<string> {
	return new SignJWT({ common_name: client }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(ISSUER).setAudience([audience]).setIssuedAt().setExpirationTime("5m").sign(key);
}

export async function call(path: string, init: RequestInit & { client?: string | null } = {}): Promise<Response> {
	const { client = "laravel.access", ...rest } = init;
	const headers = new Headers(rest.headers);
	if (client !== null) headers.set(ASSERTION_HEADER, await assertion(client));
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }));
}

/** Laravel's client as oRPC builds one from the contract, behind Access. */
export const commands: JsonifiedClient<ContractRouterClient<typeof engine>> = createORPCClient(
	new OpenAPILink(engine, {
		url: ORIGIN,
		fetch: async (request) => {
			const headers = new Headers(request.headers);
			headers.set(ASSERTION_HEADER, await assertion());
			return exports.default.fetch(new Request(request, { headers }));
		},
	}),
);

export function scope(): Scope {
	return { environment: "test", organization: uuid7(), workspace: uuid7() };
}

/** A start of a new run in a new conversation, by user 42 with no connections, unless `change` says otherwise. */
export function startOf(within: Scope, change: Partial<StartRun> = {}): StartRun {
	return {
		scope: within,
		conversation: uuid7(),
		run: uuid7(),
		user: "42",
		agent: { id: uuid7(), instructions: "Be brief.", model: "default" },
		message: { id: uuid7(), content: "Hello", attachments: [] },
		history: [],
		authority: { connections: [], layers: { ceiling: null, user: { restricted: true, revision: 1, grants: [] }, agent: null } },
		...change,
	};
}

/**
 * A start in a Notes world: the agent has the Notes connection `connectionId`, which the user may use in every folder, to
 * read and create, unless `change` says otherwise. Laravel lends it once the fake has `notesLease()` for it.
 */
export function notesStart(within: Scope, connectionId: string, change: Partial<StartRun> = {}): StartRun {
	return startOf(within, { authority: { connections: [notesConnection(connectionId)], layers: notesLayers(connectionId) }, ...change });
}

/** A start Laravel holds: its run and conversation are known to the fake, as Laravel registers them before it sends one. */
export function held(fake: FakeLaravel, start: StartRun): StartRun {
	fake.conversations.set(start.conversation, start.scope);
	fake.runs.set(start.run, heldRun(start));
	return start;
}

/** The conversation's object, where Laravel's conversations live: in the EU. */
export function objectOf(start: Pick<StartRun, "scope" | "conversation">): DurableObjectStub<Conversation> {
	return conversationObject(env, { id: start.scope.workspace, jurisdiction: "eu" }, start.conversation) as unknown as DurableObjectStub<Conversation>;
}

/** The run's view (`faultView`) with every event up to its head's `eventSeq`, read a page at a time. */
export async function viewOf(stub: DurableObjectStub<Conversation>, runId: string): Promise<RunView> {
	const first = await stub.faultView(runId);
	if (first.head === null) return first;
	const upTo = first.head.eventSeq;
	const events = [...first.events];
	while ((events.at(-1)?.seq ?? 0) < upTo) {
		const page = await stub.faultView(runId, events.at(-1)?.seq ?? 0, upTo);
		if (!page.events.length) break;
		events.push(...page.events);
	}
	return { ...first, events };
}

export async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; status: number; data: unknown }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) return { code: error.code, status: error.status, data: error.data };
		throw error;
	}
	throw new Error("The call did not fail.");
}
