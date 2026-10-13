// Host names and web addresses (test/fixtures/hosts-tests.ts) in workerd, whose URL parser and IDNA
// (`node:url` under nodejs_compat) production uses; test/unit/hosts.test.ts runs the same tests in Node.

import { expect, test } from "vitest";
import { OperationError } from "../../src/gateway/connector.ts";
import { canonicalHost } from "../../src/lib/sites.ts";
import { hostTests } from "../fixtures/hosts-tests.ts";

hostTests();

test("workerd applies the Bidi rule, which Node's encoder does not", () => {
	expect(canonicalHost("אב.com")).toBe("xn--4dbc.com");
	for (const raw of ["aא.com", "1א.com", "a׳.com", "١.com"]) expect(() => canonicalHost(raw), raw).toThrow(OperationError);
});
