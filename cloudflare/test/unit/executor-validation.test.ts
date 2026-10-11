// gateway/validation.ts against pydantic 2.13.5: each vector is what backend/connectors/executor.py
// answers (`validation_message` of `model_validate`) for an OperationInput with the fields below, written
// by a probe run with the backend's Python and copied here. The zod schema is the same input as connectors
// declare it (lib/schema.ts, registry.ts `checkStrict`).

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validateInput } from "../../src/gateway/validation.ts";
import { parseJson } from "../../src/lib/json.ts";
import { anyRecord, strictRecord, strippedStr } from "../../src/lib/schema.ts";
import { SINGLE_LINE, isSingleLine } from "../../src/lib/text.ts";

const Inner = z.strictObject({ name: strippedStr({ min: 1, max: 5 }) }).meta({ title: "Inner" });

// class Input(OperationInput):
//     project_id: Annotated[str, Field(min_length=1, max_length=10, pattern=r"^[a-z0-9-]+$")]
//     title: Annotated[str, Field(max_length=5), AfterValidator(single_line)] = "x"
//     limit: Annotated[int, Field(ge=1, le=50)] = 30
//     ratio: Annotated[float, Field(gt=0, lt=1)] = 0.5
//     flag: bool = False
//     kind: Literal["a", "b", "c"] = "a"
//     pair: Literal["x", "y"] = "x"
//     inner: Inner | None = None
//     items: Annotated[list[Inner], Field(max_length=2)] | None = None
//     names: Annotated[list[Annotated[str, Field(max_length=3)]], AfterValidator(not_two)] | None = None
//     data: Annotated[dict[str, Any], Field(max_length=2)] | None = None
//     strs: dict[str, str] | None = None
//     twice: Annotated[str, AfterValidator(not_x), AfterValidator(not_x_again)] = "y"
//     cursor: str | None = None
//     with a model_validator(mode="after") raising "the whole input" when title == "whole"
const Input = z
	.strictObject({
		project_id: strippedStr({ min: 1, max: 10 }).regex(/^[a-z0-9-]+$/),
		title: strippedStr({ max: 5 }).refine(isSingleLine, SINGLE_LINE).default("x"),
		limit: z.int().min(1).max(50).default(30),
		ratio: z.number().gt(0).lt(1).default(0.5),
		flag: z.boolean().default(false),
		kind: z.enum(["a", "b", "c"]).default("a"),
		pair: z.literal(["x", "y"]).default("x"),
		inner: Inner.nullable().default(null),
		items: z.array(Inner).max(2).nullable().default(null),
		names: z
			.array(strippedStr({ max: 3 }))
			.refine((value) => value.length !== 2, "not two")
			.nullable()
			.default(null),
		data: anyRecord({ max: 2 }).nullable().default(null),
		strs: strictRecord(strippedStr()).nullable().default(null),
		twice: strippedStr()
			.refine((value) => value !== "x", "first")
			.refine((value) => value !== "x", "second")
			.default("y"),
		cursor: strippedStr().nullable().default(null),
	})
	.refine((value) => value.title !== "whole", "the whole input")
	.meta({ title: "Input" });

const VECTORS: { json: string; message?: string; data?: unknown }[] = [
	{"json": "{\"project_id\": \"work\", \"zz\": 1, \"aa\": 2}", "message": "Invalid arguments. zz: Extra inputs are not permitted; aa: Extra inputs are not permitted"},
	{"json": "{\"zz\": 1, \"project_id\": \"BAD\"}", "message": "Invalid arguments. project_id: String should match pattern '^[a-z0-9-]+$'; zz: Extra inputs are not permitted"},
	{"json": "{\"project_id\": \"work\", \"title\": \"\\ud800\"}", "message": "Invalid arguments. title: Input should be a valid string, unable to parse raw data as a unicode string"},
	{"json": "{\"project_id\": \"\\ud800x\", \"title\": \"toolongtitle\"}", "message": "Invalid arguments. project_id: Input should be a valid string, unable to parse raw data as a unicode string; title: String should have at most 5 characters"},
	{"json": "{\"project_id\": \"work\", \"title\": \"a\\nb\"}", "message": "Invalid arguments. title: Value error, must be a single line without control characters"},
	{"json": "{\"project_id\": \"work\", \"title\": \"toolong\\n\"}", "message": "Invalid arguments. title: String should have at most 5 characters"},
	{"json": "{\"project_id\": \"work\", \"title\": \"whole\"}", "message": "Invalid arguments. input: Value error, the whole input"},
	{"json": "{\"project_id\": \"BAD\", \"title\": \"whole\"}", "message": "Invalid arguments. project_id: String should match pattern '^[a-z0-9-]+$'"},
	{"json": "{\"project_id\": \"work\", \"limit\": 1.5}", "message": "Invalid arguments. limit: Input should be a valid integer"},
	{"json": "{\"project_id\": \"work\", \"limit\": \"3\"}", "message": "Invalid arguments. limit: Input should be a valid integer"},
	{"json": "{\"project_id\": \"work\", \"limit\": true}", "message": "Invalid arguments. limit: Input should be a valid integer"},
	{"json": "{\"project_id\": \"work\", \"limit\": 0}", "message": "Invalid arguments. limit: Input should be greater than or equal to 1"},
	{"json": "{\"project_id\": \"work\", \"limit\": 51}", "message": "Invalid arguments. limit: Input should be less than or equal to 50"},
	{"json": "{\"project_id\": \"work\", \"ratio\": 0}", "message": "Invalid arguments. ratio: Input should be greater than 0"},
	{"json": "{\"project_id\": \"work\", \"ratio\": 1}", "message": "Invalid arguments. ratio: Input should be less than 1"},
	{"json": "{\"project_id\": \"work\", \"ratio\": \"x\"}", "message": "Invalid arguments. ratio: Input should be a valid number"},
	{"json": "{\"project_id\": \"work\", \"flag\": \"true\"}", "message": "Invalid arguments. flag: Input should be a valid boolean"},
	{"json": "{\"project_id\": \"work\", \"kind\": \"d\"}", "message": "Invalid arguments. kind: Input should be 'a', 'b' or 'c'"},
	{"json": "{\"project_id\": \"work\", \"pair\": \"z\"}", "message": "Invalid arguments. pair: Input should be 'x' or 'y'"},
	{"json": "{\"project_id\": \"work\", \"inner\": []}", "message": "Invalid arguments. inner: Input should be a valid dictionary or instance of Inner"},
	{"json": "{\"project_id\": \"work\", \"inner\": {\"name\": \"toolong\", \"x\": 1}}", "message": "Invalid arguments. inner.name: String should have at most 5 characters; inner.x: Extra inputs are not permitted"},
	{"json": "{\"project_id\": \"work\", \"items\": [{\"name\": \"a\"}, {\"name\": \"\"}, {\"name\": \"b\", \"q\": 1}]}", "message": "Invalid arguments. items: List should have at most 2 items after validation, not 3"},
	{"json": "{\"project_id\": \"work\", \"items\": [{\"name\": \"a\"}, {\"name\": \"b\"}, {\"name\": \"c\"}]}", "message": "Invalid arguments. items: List should have at most 2 items after validation, not 3"},
	{"json": "{\"project_id\": \"work\", \"names\": [\"a\", \"toolong\"]}", "message": "Invalid arguments. names.1: String should have at most 3 characters"},
	{"json": "{\"project_id\": \"work\", \"names\": [\"a\", \"b\"]}", "message": "Invalid arguments. names: Value error, not two"},
	{"json": "{\"project_id\": \"work\", \"names\": \"x\"}", "message": "Invalid arguments. names: Input should be a valid list"},
	{"json": "{\"project_id\": \"work\", \"data\": {\"\\ud800\": 1, \"ok\": \"\\ud800\"}}", "message": "Invalid arguments. data.\ufffd\ufffd\ufffd.[key]: Input should be a valid string, unable to parse raw data as a unicode string"},
	{"json": "{\"project_id\": \"work\", \"data\": {\"a\": 1, \"b\": 2, \"c\": 3}}", "message": "Invalid arguments. data: Dictionary should have at most 2 items after validation, not 3"},
	{"json": "{\"project_id\": \"work\", \"data\": {\" a \": 1, \"a\": 2, \"b\": 3}}", "data": {"project_id": "work", "title": "x", "limit": 30, "ratio": 0.5, "flag": false, "kind": "a", "pair": "x", "inner": null, "items": null, "names": null, "data": {"a": 2, "b": 3}, "strs": null, "twice": "y", "cursor": null}},
	{"json": "{\"project_id\": \"work\", \"strs\": {\"\\ud800\": \"a\", \"k\": \"\\udc00\", \"n\": 1}}", "message": "Invalid arguments. strs.\ufffd\ufffd\ufffd.[key]: Input should be a valid string, unable to parse raw data as a unicode string; strs.k: Input should be a valid string, unable to parse raw data as a unicode string; strs.n: Input should be a valid string"},
	{"json": "{\"project_id\": \"work\", \"twice\": \"x\"}", "message": "Invalid arguments. twice: Value error, first"},
	{"json": "{\"project_id\": 5}", "message": "Invalid arguments. project_id: Input should be a valid string"},
	{"json": "{\"project_id\": 5, \"title\": 6, \"limit\": \"7\", \"flag\": 8, \"kind\": 9, \"pair\": 10, \"zz\": 11}", "message": "Invalid arguments. project_id: Input should be a valid string; title: Input should be a valid string; limit: Input should be a valid integer; flag: Input should be a valid boolean; kind: Input should be 'a', 'b' or 'c'"},
	{"json": "[]", "message": "Invalid arguments. input: Input should be a valid dictionary or instance of Input"},
	{"json": "null", "message": "Invalid arguments. project_id: Field required"},
	{"json": "{}", "message": "Invalid arguments. project_id: Field required"},
	{"json": "{\"project_id\": \"  work  \", \"cursor\": \" c \"}", "data": {"project_id": "work", "title": "x", "limit": 30, "ratio": 0.5, "flag": false, "kind": "a", "pair": "x", "inner": null, "items": null, "names": null, "data": null, "strs": null, "twice": "y", "cursor": "c"}},
	{"json": "{\"project_id\": \"work\", \"title\": \"\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\"}", "data": {"project_id": "work", "title": "\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00", "limit": 30, "ratio": 0.5, "flag": false, "kind": "a", "pair": "x", "inner": null, "items": null, "names": null, "data": null, "strs": null, "twice": "y", "cursor": null}},
	{"json": "{\"project_id\": \"work\", \"title\": \"\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\\ud83d\\ude00\"}", "message": "Invalid arguments. title: String should have at most 5 characters"},
];

describe("tool input validation", () => {
	test.each(VECTORS)("$json", async (vector) => {
		const result = await validateInput(Input, parseJson(vector.json));
		if (vector.message !== undefined) expect(result).toEqual({ ok: false, message: vector.message });
		else expect(result).toEqual({ ok: true, data: vector.data });
	});

	test("missing arguments validate as {}", async () => {
		expect(await validateInput(Input, undefined)).toEqual({ ok: false, message: "Invalid arguments. project_id: Field required" });
		const empty = z.strictObject({ limit: z.int().default(30) });
		expect(await validateInput(empty, undefined)).toEqual({ ok: true, data: { limit: 30 } });
	});

	test("a model without a title is named generically, since zod has no class name", async () => {
		const untitled = z.strictObject({ inner: z.strictObject({ a: strippedStr() }).nullable().default(null) });
		expect(await validateInput(untitled, [])).toEqual({ ok: false, message: "Invalid arguments. input: Input should be a valid dictionary" });
		expect(await validateInput(untitled, { inner: 5 })).toEqual({ ok: false, message: "Invalid arguments. inner: Input should be a valid dictionary" });
	});

	test("values validated as Any keep their lone surrogates, as Pydantic leaves them", async () => {
		const result = await validateInput(Input, parseJson('{"project_id": "work", "data": {"k": "\\ud800", "n": {"m": "\\udc00"}}}'));
		expect(result.ok && result.data.data).toEqual({ k: "\ud800", n: { m: "\udc00" } });
	});

	test("lone surrogates are found inside lists and nested objects too", async () => {
		const nested = z.strictObject({ tags: z.array(strippedStr()).default([]), inner: Inner.nullable().default(null) });
		expect(await validateInput(nested, parseJson('{"tags": ["ok", "\\udfff"], "inner": {"name": "\\ud83d"}}'))).toEqual({
			ok: false,
			message:
				"Invalid arguments. tags.1: Input should be a valid string, unable to parse raw data as a unicode string; inner.name: Input should be a valid string, unable to parse raw data as a unicode string",
		});
		// A well-formed pair is one character.
		expect((await validateInput(nested, parseJson('{"inner": {"name": "\\ud83d\\ude00"}}'))).ok).toBe(true);
	});

	test("a dict's limits are checked only once its keys passed, lone surrogates included", async () => {
		// pydantic: only [{'type': 'string_unicode', 'loc': ('v', '<three U+FFFD>', '[key]')}].
		const limited = z.strictObject({ v: anyRecord({ max: 1 }) });
		expect(await validateInput(limited, parseJson('{"v": {"\\ud800": 1, "k": 2}}'))).toEqual({
			ok: false,
			message: "Invalid arguments. v.���.[key]: Input should be a valid string, unable to parse raw data as a unicode string",
		});
	});

	test("a union takes a lone surrogate only through a member that is not a str", async () => {
		// pydantic, `v: str | float`: string_unicode at ('v', 'constrained-str') and float_type at ('v', 'float').
		const either = z.strictObject({ v: z.union([strippedStr(), z.number()]) });
		expect(await validateInput(either, parseJson('{"v": "\\ud800"}'))).toEqual({
			ok: false,
			message: "Invalid arguments. v: Input should be a valid string, unable to parse raw data as a unicode string",
		});
		expect((await validateInput(either, { v: 1.5 })).ok).toBe(true);
		const any = z.strictObject({ v: z.union([strippedStr(), z.unknown()]) });
		expect((await validateInput(any, parseJson('{"v": "\\ud800"}'))).ok).toBe(true);
	});

	test("a str is refused for its first failing check only: length, then pattern", async () => {
		const id = z.strictObject({ id: strippedStr({ min: 1, max: 3 }).regex(/^[a-z]+$/) });
		expect(await validateInput(id, { id: "ABCD" })).toEqual({ ok: false, message: "Invalid arguments. id: String should have at most 3 characters" });
		expect(await validateInput(id, { id: "AB" })).toEqual({ ok: false, message: "Invalid arguments. id: String should match pattern '^[a-z]+$'" });
	});
});
