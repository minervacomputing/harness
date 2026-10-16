// Headers that carry a secret. Workers Logs keep request headers and blank only those whose names look secret
// (checked on the deployed Workers, 2026-10-12): `X-Minerva-Probe` and `X-Minerva-Faults` were logged whole,
// so their headers were renamed and their tokens derived anew.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { PROBE_HEADER, probeToken } from "../../src/http/probe-token.ts";
import { parseJson } from "../../src/lib/json.ts";

test("every header carrying a secret has a name Workers Logs blank", () => {
	for (const header of [PROBE_HEADER, FAULTS_HEADER]) expect(header).toMatch(/-(Token|Key)$/);
	expect(PROBE_HEADER).toBe("X-Minerva-Probe-Token");
	expect(FAULTS_HEADER).toBe("X-Minerva-Faults-Token");
});

test("the tokens logged under the old names no longer open the probe or the driver", async () => {
	// What the old headers carried for this key, derived as they were before 2026-10-12.
	const key = "a secret key";
	expect(await probeToken(key)).not.toBe("548da7ada7a1117df2530c44c74a2bc50f12e4e8e8877c1fbfad8b9a95ae0d69");
	expect(await faultsToken(key)).not.toBe("28767577865c0cf804ce16cc9b20cfbc54d965c6ede9d6aad4f4cc515d6c4baf");
	expect(await probeToken(key)).not.toBe(await faultsToken(key));
});

test("scripts/bundle.ts's markers still find the driver's header and token in a build", () => {
	const bundle = readFileSync(new URL("../../scripts/bundle.ts", import.meta.url).pathname, "utf8");
	const markers = parseJson(/const MARKERS = (\[[^\]]*\]);/.exec(bundle)?.[1] ?? "[]") as unknown as string[];
	const token = readFileSync(new URL("../../src/faults/token.ts", import.meta.url).pathname, "utf8").replace(/\/\/.*$/gm, "");
	expect(markers).toContain("X-Minerva-Faults");
	expect(markers).toContain("minerva.faults");
	expect(FAULTS_HEADER).toContain("X-Minerva-Faults");
	expect(token).toMatch(/hmacSha256Hex\(secretKey, "minerva\.faults[^"]*"\)/);
	// And the production probe's carries none of them.
	const probe = readFileSync(new URL("../../src/http/probe-token.ts", import.meta.url).pathname, "utf8");
	for (const marker of markers) expect(probe).not.toContain(marker);
});
