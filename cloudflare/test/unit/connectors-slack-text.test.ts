// The Slack connector's text and Python-semantics parts against what today's Python computes
// (test/fixtures/connectors/slack/vectors.json, written by generate.py there from backend/connectors/slack/
// and CPython 3.14), and the text cases of backend/tests/test_slack.py: the mrkdwn sanitizer, `judge`, error
// mapping, the answers' lax models, ISO times, `urlsplit` and casefold.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { decimalRanges, digitValue } from "../../src/lib/digits.ts";
import { casefold } from "../../src/lib/casefold.ts";
import { loweredPoints, pythonLower } from "../../src/lib/lower.ts";
import { Channel, Identity, Message, Posted, User, errorFor, judge, shownName } from "../../src/connectors/slack/client.ts";
import { ValueError, channelName, isTs, isoTime, moment } from "../../src/connectors/slack/connector.ts";
import { escape, redact, writtenProblem } from "../../src/connectors/slack/mrkdwn.ts";
import { fixed6, trueDivide } from "../../src/connectors/slack/times.ts";
import { hostnameOf, urlsplit } from "../../src/lib/urlsplit.ts";
import { type Json, parseJson } from "../../src/lib/json.ts";

type Answer = { in: Json; out?: unknown; error?: true; shown?: string };

/** The vectors, read with parseJson: Vite's JSON loader refuses the lone surrogates some of them hold. */
const vectors = parseJson(readFileSync(fileURLToPath(new URL("../fixtures/connectors/slack/vectors.json", import.meta.url).href), "utf8")) as unknown as {
	unicode: string;
	redacted: { in: string; out: string }[];
	written: { in: string; out?: string; error?: string }[];
	urls: { in: string; scheme?: string; netloc?: string; hostname?: string | null; error?: true }[];
	moments: { in: string; out?: string; error?: string }[];
	times: { in: string; out: string | null }[];
	channel_names: { in: string; out?: string; error?: string }[];
	ts: { in: string; out?: string; error?: string }[];
	casefold: [number, string][];
	lowered: [number, string][];
	lower_words: { in: string; out: string; folded: string }[];
	decimals: [number, number][];
	folded: { in: string; out: string }[];
	channels: Answer[];
	messages: Answer[];
	identities: Answer[];
	posted: Answer[];
	users: Answer[];
	int_texts: { in: string; out?: string; error?: true }[];
	errors: [Json, string, string][];
};

const SECRET = "SECRET plans";
const PRIVATE = "G0PRIVATE1";
const GENERAL = "C0GENERAL1";

/** What a validator answers: its value, or its message. */
function attempt(fn: (value: string) => string, value: string): { out: string } | { error: string } {
	try {
		return { out: fn(value) };
	} catch (error) {
		if (error instanceof ValueError) return { error: error.message };
		throw error;
	}
}

function model(schema: z.ZodType, value: unknown): { out: unknown } | { error: true } {
	const parsed = schema.safeParse(value);
	return parsed.success ? { out: parsed.data } : { error: true };
}

describe("text (test_slack.py)", () => {
	test("read text hides names of linked channels", () => {
		const shown = redact(
			`<#${PRIVATE}|${SECRET}> <https://acme.slack.com/archives/${PRIVATE}/p1|${SECRET}> ` +
				`<https://acme%2Eslack.com/x|${SECRET}> <https://acme.slack-gov.com/archives/${PRIVATE}/p1|${SECRET}> ` +
				`<slack://channel?team=T0ACME&id=${PRIVATE}|${SECRET}> ` +
				`<https://example.com|docs> <@U0ADA|ada> <#${GENERAL}>`,
		);
		expect(shown).not.toContain(SECRET);
		expect(shown).toContain(`<#${PRIVATE}>`);
		expect(shown).toContain(`<https://acme.slack.com/archives/${PRIVATE}/p1>`);
		for (const kept of ["<https://example.com|docs>", "<@U0ADA|ada>", `<#${GENERAL}>`]) expect(shown).toContain(kept);
	});

	test.each([
		"see https://acme.slack.com/archives/C0GENERAL1/p1727780000000100",
		"slack.com/archives/C1",
		"acme.slack%2Ecom/archives",
		"acme.slack&#46;com/archives",
		"acme.slack\uff0ecom/archives",
		"acme.slack\u200b.com",
		"acme.slack\\.com",
		"files.slack-files.com/x",
		"https://acme.slack-gov.com/archives/C0PRIVATE1/p1",
		"slack://channel?team=T0ACME&id=C0PRIVATE1",
		"bell\x07",
	])("written text may not link to Slack: %j", (written) => {
		expect(writtenProblem(written)).not.toBeNull();
	});

	test("written text is escaped", () => {
		expect(writtenProblem("*Done* & <!channel> <@U0ADA> <https://x|y>\n- next")).toBeNull();
		expect(escape("a & <!here> <@U0ADA>")).toBe("a &amp; &lt;!here&gt; &lt;@U0ADA&gt;");
	});

	test("judge claims only what Slack confirms", () => {
		const response = (status: number, body: unknown): [Response, string] => {
			const text = typeof body === "string" ? body : JSON.stringify(body);
			return [new Response([101, 103, 204, 205, 304].includes(status) ? null : text, { status }), text];
		};
		const judged = (status: number, body: unknown) => judge(...response(status, body));
		expect(judged(200, { ok: true, ts: "1.2" })).toBe("applied");
		for (const error of ["not_in_channel", "is_archived", "ratelimited", "invalid_auth", "msg_too_long", "accesslimited"]) {
			expect(judged(200, { ok: false, error })).toBe("not_applied");
		}
		for (const error of ["internal_error", "fatal_error", "request_timeout", "something_new", null]) {
			expect(judged(200, { ok: false, error })).toBe("unknown");
		}
		expect(judged(200, "<html>")).toBe("unknown");
		expect(judged(200, [1])).toBe("unknown");
		// Slack answers with 200; any other success status is judged by its body all the same.
		expect(judged(201, { ok: false, error: "not_in_channel" })).toBe("not_applied");
		expect(judged(204, "")).toBe("unknown");
		expect(judged(429, { ok: false, error: "ratelimited" })).toBeNull();
		expect(judged(500, "")).toBeNull();
		// As json.loads reads bytes: a byte order mark is skipped.
		expect(judged(200, '\ufeff{"ok": true}')).toBe("applied");
	});
});

describe("against Python", () => {
	test("the vectors come from the Unicode version the table was made with", () => {
		expect(vectors.unicode).toBe("16.0.0");
	});

	test.each(vectors.redacted)("redact $in", ({ in: text, out }) => {
		expect(redact(text)).toBe(out);
	});

	test.each(vectors.written)("check_written $in", (vector) => {
		const problem = writtenProblem(vector.in);
		expect(problem === null ? { out: vector.in } : { error: problem }).toEqual("out" in vector ? { out: vector.out } : { error: vector.error });
	});

	test.each(vectors.urls)("urlsplit $in", (vector) => {
		const parts = urlsplit(vector.in);
		const answer = parts === null ? { in: vector.in, error: true } : { in: vector.in, scheme: parts.scheme, netloc: parts.netloc, hostname: hostnameOf(parts.netloc) };
		expect(answer).toEqual(vector);
	});

	test.each(vectors.moments)("_moment $in", (vector) => {
		const { in: value, ...expected } = vector;
		expect(attempt(moment, value)).toEqual(expected);
	});

	test.each(vectors.times)("_time $in", ({ in: ts, out }) => {
		expect(isoTime(ts)).toBe(out);
	});

	test.each(vectors.channel_names)("_channel_name $in", (vector) => {
		const { in: value, ...expected } = vector;
		expect(attempt(channelName, value)).toEqual(expected);
	});

	test.each(vectors.ts)("_ts $in", (vector) => {
		expect(isTs(vector.in)).toBe("out" in vector);
	});

	test("casefold: every code point Python folds otherwise than it lowercases, and words", () => {
		for (const [point, folded] of vectors.casefold) expect(casefold(String.fromCodePoint(point))).toBe(folded);
		for (const { in: text, out } of vectors.folded) expect(casefold(text)).toBe(out);
	});

	test("Unicode 16 as Python has it, whatever the runtime's: lower(), casefold() and the decimal digits", () => {
		// Every code point Python lowercases, and what to: the runtime maps them alike (case pairs are stable).
		expect(loweredPoints()).toEqual(vectors.lowered.map(([point]) => point));
		for (const [point, lower] of vectors.lowered) expect(pythonLower(String.fromCodePoint(point)), point.toString(16)).toBe(lower);
		// Characters cased since (Node 24 has Unicode 17) stay as they are, as in Python.
		for (const { in: text, out, folded } of vectors.lower_words) {
			expect(pythonLower(text), text).toBe(out);
			expect(casefold(text), text).toBe(folded);
		}
		expect(decimalRanges()).toEqual(vectors.decimals);
		for (const [first, last] of vectors.decimals) {
			for (let point = first; point <= last; point++) expect(digitValue(String.fromCodePoint(point))).toBe((point - first) % 10);
		}
		// U+11DE0 to U+11DE9 became digits in Unicode 17.
		expect(digitValue("\u{11de1}")).toBeNull();
		expect(isTs("\u{11de1}".repeat(10) + "." + "\u{11de1}".repeat(6))).toBe(false);
		expect(channelName("꟎")).toBe("#꟎");
	});

	test.each([
		["channels", Channel, vectors.channels],
		["messages", Message, vectors.messages],
		["identities", Identity, vectors.identities],
		["posted", Posted, vectors.posted],
	] as const)("lax models: %s", (_name, schema, cases) => {
		for (const vector of cases) {
			expect(model(schema, vector.in), JSON.stringify(vector.in)).toEqual("out" in vector ? { out: vector.out } : { error: true });
		}
	});

	test("lax models: text read as an int, by pydantic-core's rules", () => {
		for (const vector of vectors.int_texts) {
			const parsed = Channel.safeParse({ id: "C1", num_members: vector.in });
			// A number is a double here: Python's digits past 2**53 are rounded, and past a double's range refused.
			const expected = vector.out === undefined || !Number.isFinite(Number(vector.out)) ? { error: true } : { out: Number(vector.out) };
			expect(parsed.success ? { out: parsed.data.num_members } : { error: true }, JSON.stringify(vector.in)).toEqual(expected);
		}
	});

	test("lax models: users and the names Slack shows", () => {
		for (const vector of vectors.users) {
			const parsed = User.safeParse(vector.in);
			expect(parsed.success ? { out: parsed.data, shown: shownName(parsed.data) } : { error: true }, JSON.stringify(vector.in)).toEqual(
				"out" in vector ? { out: vector.out, shown: vector.shown } : { error: true },
			);
		}
	});

	test.each(vectors.errors)("error_for %j", (code, expected, message) => {
		const error = errorFor("Slack", code);
		expect([error.code, error.message]).toEqual([expected, message]);
	});
});

describe("float arithmetic as Python's", () => {
	test("int true division rounds to the nearest double, ties to even", () => {
		expect(trueDivide(1n, 3n)).toBe(1 / 3);
		expect(trueDivide(-1n, 1_000_000n)).toBe(-1e-6);
		expect(trueDivide(190302784496789012n, 1_000_000n)).toBe(190302784496.789);
		// 2**53 + 1 is a tie between 2**53 and 2**53 + 2: even wins; 2**53 + 3 rounds up.
		expect(trueDivide(2n ** 53n + 1n, 1n)).toBe(2 ** 53);
		expect(trueDivide(2n ** 53n + 3n, 1n)).toBe(2 ** 53 + 4);
		expect(trueDivide(0n, 7n)).toBe(0);
	});

	test("'.6f' rounds the exact value half to even", () => {
		expect(fixed6(0.0078125)).toBe("0.007812");
		expect(fixed6(0.0234375)).toBe("0.023438");
		expect(fixed6(-1e-6)).toBe("-0.000001");
		expect(fixed6(-1e-7)).toBe("-0.000000");
		expect(fixed6(1727779800)).toBe("1727779800.000000");
		// The double's exact value, digit for digit, as Python writes it.
		expect(fixed6(1e300)).toBe(`${BigInt(1e300)}.000000`);
	});
});
