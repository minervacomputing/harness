// What CI's instance masks in the public Actions log (scripts/masks.ts, docs/plans/ci-account-suites.md): every
// value of its secrets that a log could show, as GitHub's `::add-mask::` commands.

import { describe, expect, test } from "vitest";
import { ciMaskValues, maskCommands } from "../../scripts/masks.ts";
import { faultsToken } from "../../src/faults/token.ts";

const SECRET_KEY = "s3cr3t-key-of-forty-characters-0123456789";
const SECRETS = [`MINERVA_SECRET_KEY=${SECRET_KEY}`, 'MINERVA_LARAVEL_TOKEN="1|laravel-token-0123456789abcdef"', "export MINERVA_STREAM_KEYS='k1:stream-key-0123456789'", "MINERVA_MODEL_API_KEY=model-key-0123456789 # a comment", "SHORT=yes", ""].join("\n");

describe("the values CI masks", () => {
	test("the account, each secret in both readings and the fault token, and nothing shorter than 8 characters", async () => {
		const values = await ciMaskValues({ account: " 0123456789abcdef0123456789abcdef\n", secrets: SECRETS });
		// Each once, in no particular order (dotenv's parser gives its own).
		expect(values.toSorted()).toEqual(
			[
				"0123456789abcdef0123456789abcdef",
				SECRET_KEY,
				"1|laravel-token-0123456789abcdef",
				"k1:stream-key-0123456789",
				"model-key-0123456789",
				"model-key-0123456789 # a comment",
				await faultsToken(SECRET_KEY),
			].toSorted(),
		);
	});

	test("no secrets, and no secret key, leave the account alone", async () => {
		expect(await ciMaskValues({ account: "id", secrets: "" })).toEqual(["id"]);
	});
});

describe("the mask commands", () => {
	test("one per line of each value, escaped, without blank lines or repeats", () => {
		expect(maskCommands(["a%b", "line one\nline two", "x\r", "line one", "  "])).toEqual(["::add-mask::a%25b", "::add-mask::line one", "::add-mask::line two", "::add-mask::x%0D"]);
	});
});
