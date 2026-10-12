// Headers that carry a secret. Workers Logs keep request headers and blank only those whose names look secret
// (checked on the deployed Workers, 2026-10-12): `X-Minerva-Probe` and `X-Minerva-Faults` were logged whole,
// so their tokens were renamed and derived anew.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { SETUP_KEY_HEADER } from "../../src/accounts/instance.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { saltedHmacHex } from "../../src/lib/hash.ts";
import { parseJson } from "../../src/lib/json.ts";

test("every header carrying a secret has a name Workers Logs blank", () => {
	for (const header of [PROBE_HEADER, FAULTS_HEADER, SETUP_KEY_HEADER]) expect(header).toMatch(/-(Token|Key)$/);
	expect(PROBE_HEADER).toBe("X-Minerva-Probe-Token");
	expect(FAULTS_HEADER).toBe("X-Minerva-Faults-Token");
});

test("the tokens logged under the old names no longer open the probe or the driver", async () => {
	const key = "a secret key";
	expect(await probeToken(key)).not.toBe(await saltedHmacHex("minerva.probe", "probe", key, "SHA-256"));
	expect(await faultsToken(key)).not.toBe(await saltedHmacHex("minerva.faults", "faults", key, "SHA-256"));
	expect(await probeToken(key)).not.toBe(await faultsToken(key));
});

test("scripts/bundle.ts's markers still find the driver's header and token in a build", () => {
	const bundle = readFileSync(new URL("../../scripts/bundle.ts", import.meta.url).pathname, "utf8");
	const markers = parseJson(/const MARKERS = (\[[^\]]*\]);/.exec(bundle)?.[1] ?? "[]") as unknown as string[];
	const token = readFileSync(new URL("../../src/faults/token.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
	expect(markers).toContain("X-Minerva-Faults");
	expect(markers).toContain("minerva.faults");
	expect(FAULTS_HEADER).toContain("X-Minerva-Faults");
	expect(token).toMatch(/saltedHmacHex\("minerva\.faults[^"]*"/);
	// And the production probe's carries none of them.
	const probe = readFileSync(new URL("../../src/http/probe-token.ts", import.meta.url).pathname, "utf8");
	for (const marker of markers) expect(probe).not.toContain(marker);
});
