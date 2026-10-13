// Teams' text and inputs against what today's Python computes (test/fixtures/connectors/teams/generate.py):
// which addresses count as addresses to Teams and what replaces them, the text agents may write, the code
// points Python's IGNORECASE reads as each letter of the addresses, and the six tools' inputs. Text with an
// invisible control or noncharacter that Python let through is skipped: such a character no longer splits
// an address, so it may now be hidden or refused.

import { describe, expect, test } from "vitest";
import { teamsConnector } from "../../src/connectors/teams/connector.ts";
import { TEAMS, checkWritten, read, redact, toTeams, written } from "../../src/connectors/teams/html.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import type { Json } from "../../src/lib/json.ts";
import { TextError } from "../../src/lib/text.ts";
import { operation, vectors } from "../fixtures/connectors/microsoft/runs.ts";
import { changedOnPurpose, hasInvisible } from "./changed.ts";

type Recipe = { $repeat: [string, number] };

/** A long run of one character is stored as a recipe (see generate.py's `pack`). */
function unpack(value: unknown): unknown {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record = value as { [key: string]: unknown };
		if (Object.keys(record).length === 1 && "$repeat" in record) {
			const [char, count] = (record as Recipe).$repeat;
			return char.repeat(count);
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, unpack(item)]));
	}
	return value;
}

const dataset = vectors("teams") as {
	redact: { text: string; value: string; teams: boolean }[];
	check_written: { text: unknown; value?: string; error?: string }[];
	written: { text: unknown; value: string }[];
	letters: { base: string; at: number; points: number[] }[];
	inputs: { [tool: string]: { args: Json; data?: Json; message?: string; raises?: string }[] };
};

describe("message text against today's Python", () => {
	test("redact and the addresses to Teams, in any encoding", () => {
		expect(dataset.redact.length).toBeGreaterThan(450);
		const failures: string[] = [];
		for (const expected of dataset.redact) {
			if (hasInvisible(expected.text) && !expected.teams) continue;
			const actual = { value: redact(expected.text), teams: toTeams(expected.text) };
			if (actual.value !== expected.value || actual.teams !== expected.teams) {
				failures.push(`${JSON.stringify(expected.text).slice(0, 200)}\n   python ${JSON.stringify([expected.value, expected.teams]).slice(0, 200)}\n   ts     ${JSON.stringify(actual).slice(0, 200)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("every character of every address reads as the same code points as Python's IGNORECASE", () => {
		const failures: string[] = [];
		for (const { base, at, points } of dataset.letters) {
			const expected = new Set(points);
			const head = base.slice(0, at);
			const tail = base.slice(at + 1);
			const found: number[] = [];
			for (let point = 0; point < 0x30000; point++) {
				if (point >= 0xd800 && point <= 0xdfff) continue;
				if (TEAMS.test(head + String.fromCodePoint(point) + tail)) found.push(point);
			}
			if (found.length !== expected.size || found.some((point) => !expected.has(point))) {
				failures.push(`${base}[${at}]: python ${points.map((p) => p.toString(16))}, ts ${found.map((p) => p.toString(16))}`);
			}
		}
		expect(dataset.letters.length).toBeGreaterThan(90);
		expect(failures).toEqual([]);
	});
});

describe("text agents write", () => {
	test("check_written: refuses control characters and addresses to Teams with Python's words", () => {
		expect(dataset.check_written.length).toBeGreaterThan(200);
		const failures: string[] = [];
		for (const expected of dataset.check_written) {
			const text = unpack(expected.text) as string;
			if (hasInvisible(text) && expected.error === undefined) continue;
			let actual: { value?: string; error?: string };
			try {
				actual = { value: checkWritten(text) };
			} catch (error) {
				if (!(error instanceof TextError)) throw error;
				actual = { error: error.message };
			}
			const want = expected.error !== undefined ? { error: expected.error } : { value: expected.value };
			if (JSON.stringify(actual) !== JSON.stringify(want)) failures.push(`${JSON.stringify(text).slice(0, 100)}: python ${JSON.stringify(want).slice(0, 200)}, ts ${JSON.stringify(actual).slice(0, 200)}`);
		}
		expect(failures).toEqual([]);
	});

	test("written: html.escape, then line breaks", () => {
		expect(dataset.written.length).toBeGreaterThan(60);
		for (const expected of dataset.written) expect(written(unpack(expected.text) as string)).toBe(expected.value);
	});
});

describe("tool inputs", () => {
	for (const name of ["list_teams", "list_channels", "read_channel", "read_thread", "post_message", "reply"]) {
		test(`inputs of ${name}: normalized arguments and Pydantic's messages`, async () => {
			const cases = dataset.inputs[name] as { args: Json; data?: Json; message?: string; raises?: string }[];
			expect(cases.length).toBeGreaterThan(1);
			const op = operation(teamsConnector(), name);
			const failures: string[] = [];
			for (const expected of cases) {
				const args = unpack(expected.args) as Json;
				if (changedOnPurpose(args)) continue;
				const result = await validateInput(op.input as never, args);
				const actual = result.ok ? { data: result.data as Json } : { refused: true };
				const want = expected.message !== undefined ? { refused: true } : { data: unpack(expected.data) as Json };
				if (JSON.stringify(actual) !== JSON.stringify(want)) {
					failures.push(`${JSON.stringify(expected.args).slice(0, 200)}\n   python ${JSON.stringify(want).slice(0, 300)}\n   ts     ${JSON.stringify(actual).slice(0, 300)}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}
});

describe("bounds", () => {
	test("a link never closed around two hundred thousand pieces of text is shown", () => {
		// Before: the label's pieces were spread into push(), and that many arguments overflow the stack.
		const text = read(`<a href="https://example.com/">${"y<br>".repeat(200_000)}`, "html", []);
		expect(text.startsWith("y\ny\n")).toBe(true);
	});
});

describe("nested links", () => {
	const H = "https://example.com/";
	test("read as Python reads them, in about linear time", () => {
		expect(read(`<a href=" ${H} ">a<a href="${H}b">  b <b>c</b>  </a>  </a>tail`, "html", [])).toBe(`ab c (${H}b) ( ${H} )tail`);
		expect(read(`<a href="">  </a>q<a href="${H}"> </a>`, "html", [])).toBe(`q${H}`);
		// Before: each closing link joined its whole label again, so the text was copied once per level.
		const depth = 100_000;
		const started = performance.now();
		const text = read(`${`<a href="${H}">`.repeat(depth)}x${"</a>".repeat(depth)}`, "html", []);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(text === `x${` (${H})`.repeat(depth)}`).toBe(true);
	});
});
