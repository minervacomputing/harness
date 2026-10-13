// The syntax check before a script is loaded (src/scripts/syntax.ts) and the checks of what a guest
// answers (src/scripts/outcome.ts).

import { describe, expect, test } from "vitest";
import { guestOutcome, thrownOutcome } from "../../src/scripts/outcome.ts";
import { HEAD_CHARS } from "../../src/scripts/limits.ts";
import { syntaxError } from "../../src/scripts/syntax.ts";

describe("syntax", () => {
	test("a function body passes: top-level await and return, directives, comments at the end, new.target and arguments", () => {
		for (const code of [
			"return 1",
			"const page = await tools.list_things({})\nreturn page.count",
			"'use strict'; return this",
			"return 1 // the answer",
			"/* a */ return 2 /* b */",
			"return new.target === undefined",
			"return arguments.length",
			"",
			"label: for (;;) break label",
		]) {
			expect(syntaxError(code), code).toBeNull();
		}
	});

	test("an error carries acorn's words and the code's own line and column", () => {
		expect(syntaxError("const a = ;")).toEqual({ message: "Unexpected token (1:10)", stack: "SyntaxError: Unexpected token (1:10)" });
		expect(syntaxError("return 1\nconst = 2")?.message).toBe("Unexpected token (2:6)");
		expect(syntaxError("return (")?.message).toBe("Unexpected token (1:8)");
	});

	test("code cannot end the wrapper's function early", () => {
		for (const code of ["return 1 }\nexport const x = 1; function y() {", "}; }; (function () {", "return 1 }; }; module.exports = () => { return 2", "}\n})(); (() => {"]) {
			expect(syntaxError(code), code).not.toBeNull();
		}
	});
});

describe("guest answers", () => {
	test("a well-formed answer passes", () => {
		expect(guestOutcome({ ok: true, value: { text: "v" }, writes: [["a", "1"], ["b"]], unsettled: 2 })).toEqual({
			ok: true,
			value: { text: "v" },
			writes: { set: [["a", "1"]], delete: ["b"] },
			unsettled: 2,
		});
		expect(guestOutcome({ ok: false, error: { name: "TypeError", message: "m", stack: "TypeError: m" }, unsettled: 0 })).toEqual({
			ok: false,
			error: { kind: "script", message: "m", stack: "TypeError: m" },
			unsettled: 0,
		});
		expect(guestOutcome({ ok: true, value: { text: "x", rest: { bytes: 3, newlines: 1, last: false } }, writes: [] })).toMatchObject({ value: { text: "x", rest: { bytes: 3 } } });
	});

	test("a store whose deleted and replacing keys together pass 1 Mi characters is still valid (opencode's case)", () => {
		const answer = { ok: true, writes: [["a".repeat(600_000)], ["b".repeat(600_000), "1"]], unsettled: 0 };
		expect(guestOutcome(answer)).toMatchObject({ ok: true, writes: { set: [["b".repeat(600_000), "1"]], delete: ["a".repeat(600_000)] } });
	});

	test("anything else is a broken bridge, in pi-codemode's words", () => {
		const broken = (answer: unknown) => guestOutcome(answer);
		for (const [answer, detail] of [
			[null, "the answer is not an object"],
			[{ ok: "yes" }, "the answer is malformed"],
			[{ ok: true, writes: [], extra: 1 }, "the answer has an unknown field"],
			[{ ok: true, writes: {} }, "store writes are not an array"],
			[{ ok: true, writes: [[1, "2"]] }, "store writes contain a malformed entry"],
			[{ ok: true, writes: [["k", "{"]] }, 'store value for "k" is not valid JSON'],
			[{ ok: true, writes: [["k", JSON.stringify("x".repeat(262144))]] }, "store writes are over the store's limits"],
			[{ ok: true, writes: [], value: "text" }, "the returned value is not an object"],
			[{ ok: true, writes: [], value: { text: "x".repeat(HEAD_CHARS + 1) } }, "the returned value is longer than its head"],
			[{ ok: true, writes: [], value: { text: "x", rest: { bytes: 1, newlines: 2, last: true } } }, "the returned value is malformed"],
			[{ ok: true, writes: [], unsettled: -1 }, "the count of unsettled calls is malformed"],
			[{ ok: false, error: { message: 5 } }, "script error is not a string"],
			[{ ok: false, error: { name: 5, message: "m" } }, "script error is malformed"],
		] as const) {
			expect(broken(answer)).toEqual({
				ok: false,
				error: { kind: "sandbox", message: `Sandbox bridge broken: ${detail}. The script may have modified built-ins such as a prototype's toJSON.` },
				unsettled: 0,
			});
		}
	});

	test("the platform's stops become script and sandbox errors", () => {
		expect(thrownOutcome(new Error("Worker exceeded CPU time limit."), 30_000).ok === false && thrownOutcome(new Error("Worker exceeded CPU time limit."), 30_000)).toMatchObject({
			error: { kind: "sandbox", message: "The script was stopped after 30 seconds of computation." },
		});
		expect(thrownOutcome(new Error("Worker exceeded memory limit."), 30_000)).toMatchObject({ error: { kind: "sandbox", message: "The script was stopped for using more than about 256 MB of memory." } });
		expect(
			thrownOutcome(new Error("The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response."), 1000),
		).toMatchObject({ error: { kind: "script", message: "The script is waiting on a promise that can never settle: no tool call or timer is pending." } });
		expect(thrownOutcome(new Error("Network connection lost."), 1000)).toMatchObject({ error: { kind: "sandbox", message: "Sandbox host failed: Network connection lost." } });
	});
});
