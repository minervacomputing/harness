// The settings calls Laravel makes with a credential it holds (src/internal/connections.ts), against a fake GitHub reached
// through `PROVIDER_NETWORK`.

import { afterEach, describe, expect, test } from "vitest";
import { PROVIDER_NETWORK } from "../../src/api/providers.ts";
import { uuid7 } from "../../src/lib/random.ts";
import { commands, refusalOf, scope, signedAssertions } from "./internal-support.ts";

signedAssertions();

const defaultNetwork = PROVIDER_NETWORK.fetch;
afterEach(() => {
	PROVIDER_NETWORK.fetch = defaultNetwork;
});

/** GitHub's `GET /user`, answered by `answer`; the tokens it saw are recorded. */
function fakeGitHub(answer: () => Response): string[] {
	const seen: string[] = [];
	PROVIDER_NETWORK.fetch = () => async (input, init) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		if (request.method !== "GET" || request.url !== "https://api.github.com/user") throw new TypeError(`Unexpected request ${request.method} ${request.url}`);
		seen.push(request.headers.get("Authorization") ?? "");
		return answer();
	};
	return seen;
}

function describeAccount(provider = "github", kind: "oauth2" | "api_key" | "builtin" = "oauth2", within = scope()) {
	return commands.describeAccount({ scope: within, connection: { id: uuid7(), provider }, credential: { kind, secret: "gho_token", generation: 1 } });
}

describe("describeAccount", () => {
	test("the account behind the credential: its stable id and label, and no tenant yet", async () => {
		const seen = fakeGitHub(() => Response.json({ id: 583231, login: "octocat" }));
		expect(await describeAccount()).toEqual({ outcome: "described", account: { id: "583231", label: "octocat", tenant: null } });
		expect(seen).toEqual(["Bearer gho_token"]);
	});

	test("a credential the provider refuses is CREDENTIAL_REFUSED; another failure PROVIDER_FAILED", async () => {
		fakeGitHub(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
		expect(await describeAccount()).toMatchObject({ outcome: "refused", code: "CREDENTIAL_REFUSED" });
		fakeGitHub(() => new Response("upstream", { status: 502 }));
		expect(await describeAccount()).toMatchObject({ outcome: "refused", code: "PROVIDER_FAILED" });
	});

	test("a key the provider refuses is CREDENTIAL_REFUSED, also where the connector words the refusal itself (Stripe)", async () => {
		PROVIDER_NETWORK.fetch = () => async () => Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
		const refused = await commands.describeAccount({ scope: scope(), connection: { id: uuid7(), provider: "stripe" }, credential: { kind: "api_key", secret: "rk_test_0123456789abcdef", generation: 1 } });
		expect(refused).toEqual({ outcome: "refused", code: "CREDENTIAL_REFUSED", message: "Stripe did not accept this key." });
	});

	test("an unknown connector is NOT_FOUND, a credential of another kind VALIDATION_FAILED, another environment WRONG_ENVIRONMENT", async () => {
		const seen = fakeGitHub(() => Response.json({ id: 1, login: "octocat" }));
		expect(await refusalOf(describeAccount("nothing"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
		expect(await refusalOf(describeAccount("github", "api_key"))).toMatchObject({
			code: "VALIDATION_FAILED",
			status: 422,
			data: { issues: [{ path: ["credential", "kind"] }] },
		});
		expect(await refusalOf(describeAccount("github", "oauth2", { ...scope(), environment: "staging" }))).toMatchObject({ code: "WRONG_ENVIRONMENT", status: 409 });
		expect(seen).toEqual([]);
	});
});
