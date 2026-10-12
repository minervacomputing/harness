// The HubSpot connector against what today's Python computes (test/fixtures/connectors/hubspot/vectors.json,
// written by generate.py beside it): every operation's input normalization and validation messages, with
// the query hashes and write keys of the normalized arguments, the response models' lax reading, and the
// helpers whose words or arithmetic matter.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Operation } from "../../src/contracts/connectors.ts";
import { casefold } from "../../src/lib/casefold.ts";
import { HubSpotClient, classify } from "../../src/connectors/hubspot/client.ts";
import { SCOPES, hubspotConnector } from "../../src/connectors/hubspot/connector.ts";
import {
	type Batch,
	type Details,
	type HubRecord,
	type Pipeline,
	type Pipelines,
	type Reader,
	type SearchPage,
	type Stage,
	fromJsonText,
	readBatch,
	readDetails,
	readPipeline,
	readPipelines,
	readRecord,
	readSearchPage,
} from "../../src/connectors/hubspot/models.ts";
import { pipelineData } from "../../src/connectors/hubspot/reads.ts";
import { type SearchOptions, after, following, recordData, searchBody } from "../../src/connectors/hubspot/scope.ts";
import { noteHtml } from "../../src/connectors/hubspot/writes.ts";
import { OperationError, operationOf, termsOf } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { writeKey } from "../../src/gateway/ledger.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import { type Json, type JsonObject, canonicalAscii, parseJson } from "../../src/lib/json.ts";

interface InputVector {
	op: string;
	raw: Json;
	dump?: JsonObject;
	query_hash?: string;
	write_key?: string;
	message?: string;
	raised?: string;
}

type Failure = { code: string; message: string };

interface Vectors {
	python: string;
	scopes: string[];
	declaration: JsonObject;
	schemas: [string, JsonObject][];
	inputs: InputVector[];
	responses: { model: string; text: string; json_mode: Json; python_mode: Json }[];
	note_html: [string, string][];
	after: [string | null, number, string | null | Failure][];
	following: [JsonObject, number, [string | null, boolean] | Failure][];
	record_data: { record: JsonObject; properties: string[]; data: JsonObject }[];
	pipeline_data: { pipeline: JsonObject; data: JsonObject }[];
	search_body: { options: SearchOptions; body: JsonObject }[];
	classify: [number, string, Failure | null][];
	casefold: [string, string][];
	casefold_all: string;
}

const vectors = parseJson(readFileSync(new URL("../fixtures/connectors/hubspot/vectors.json", import.meta.url).pathname, "utf8")) as unknown as Vectors;

const connector = hubspotConnector();

function op(name: string): Operation<never> {
	const found = operationOf(connector, name);
	if (found === null) throw new Error(`No operation ${name}`);
	return found;
}

function failure(run: () => unknown): unknown {
	try {
		return run();
	} catch (error) {
		if (error instanceof OperationError) return { code: error.code, message: error.message };
		throw error;
	}
}

/** The connector's declaration as base.py's dataclasses spell it, every default filled in. */
function declared(): JsonObject {
	const auth = connector.auth;
	if (auth.type !== "oauth2") throw new Error("HubSpot connects through OAuth.");
	return {
		slug: connector.slug,
		name: connector.name,
		kinds: connector.kinds.map((kind) => ({
			id: kind.id,
			label: kind.label,
			actions: kind.actions,
			wildcard: kind.wildcard ?? false,
			hierarchical: kind.hierarchical ?? false,
			note: kind.note ?? null,
			listed: kind.listed ?? true,
		})),
		actions: connector.actions.map((action) => ({ id: action.id, label: action.label, requires: action.requires ?? null })),
		auth: {
			app: auth.app,
			authorize_url: auth.authorizeUrl,
			token_url: auth.tokenUrl,
			scopes: auth.scopes,
			scope_separator: auth.scopeSeparator ?? " ",
			registration_url: auth.registrationUrl ?? null,
			authorize_params: auth.authorizeParams ?? [],
			login_hint: auth.loginHint ?? false,
			client_auth: auth.clientAuth ?? "post",
			json_body: auth.jsonBody ?? false,
			pkce: auth.pkce ?? true,
		},
		browsable: connector.browsable ?? [],
		manage_link: connector.manageLink?.() ?? null,
		operations: connector.operations.map((item) => {
			const terms = termsOf(item);
			return {
				name: item.name,
				title: item.title,
				description: item.description,
				needs: item.needs,
				output_action: terms.outputAction,
				consent: terms.consent,
				revision: terms.revision,
				mutates: terms.mutates,
				paginated: terms.paginated,
			};
		}),
	};
}

describe("what the model and users see", () => {
	test("the declaration, every word of it, is today's", () => {
		expect(declared()).toEqual(vectors.declaration);
		expect(connector.operations.every((item) => connector.offered?.(item) ?? true)).toBe(true);
	});

	test("each input's JSON Schema is Pydantic's, without its titles", () => {
		expect(vectors.schemas.map(([name]) => name)).toEqual(connector.operations.map((item) => item.name));
		for (const [name, schema] of vectors.schemas) expect(inputSchema(op(name))).toEqual(schema);
	});
});

describe("inputs, as the executor validates them", () => {
	test("the vectors cover every operation", () => {
		expect(new Set(vectors.inputs.map((vector) => vector.op))).toEqual(new Set(connector.operations.map((item) => item.name)));
		expect(SCOPES).toEqual(vectors.scopes);
	});

	test.each(vectors.inputs.map((vector) => [`${vector.op} ${JSON.stringify(vector.raw).slice(0, 80)}`, vector] as const))("%s", async (_, vector) => {
		const operation = op(vector.op);
		const validated = await validateInput(operation.input, vector.raw);
		if (vector.dump !== undefined) {
			expect(validated).toEqual({ ok: true, data: vector.dump });
			if (!validated.ok) return;
			// Hashed over the normalized arguments, so a page token and a write key are today's.
			expect(await queryHash(validated.data)).toBe(vector.query_hash);
			if (vector.write_key !== undefined) expect(await writeKey(`hubspot_${vector.op}`, validated.data)).toBe(vector.write_key);
			else expect(operation.mutates ?? false).toBe(false);
		} else if (vector.message !== undefined) {
			expect(validated).toEqual({ ok: false, message: vector.message });
		} else {
			// A null email or domain failed the call in Python (its validator was handed None, a TypeError the
			// executor reported as a failure); here it means none, as a null query does.
			expect(vector.raised).toBe("TypeError");
			expect(validated.ok).toBe(true);
			const key = Object.keys(vector.raw as JsonObject)[0] as string;
			expect(validated.ok && validated.data[key]).toBeNull();
		}
	});
});

// The models' readings, written as Python dumps them (snake_case, integers as strings).

function dumpRecord(record: HubRecord): JsonObject {
	return { id: record.id, properties: Object.fromEntries(record.properties), archived: record.archived };
}

function dumpStage(stage: Stage): JsonObject {
	return { id: stage.id, label: stage.label, display_order: String(stage.displayOrder), archived: stage.archived, metadata: Object.fromEntries(stage.metadata) };
}

function dumpPipeline(pipeline: Pipeline): JsonObject {
	return { id: pipeline.id, label: pipeline.label, display_order: String(pipeline.displayOrder), archived: pipeline.archived, stages: pipeline.stages.map(dumpStage) };
}

const MODELS: { [name: string]: (value: Json) => JsonObject } = {
	Details: (value) => {
		const found: Details = readDetails(value);
		return { portal_id: String(found.portalId), portal_name: found.portalName, ui_domain: found.uiDomain };
	},
	Record: (value) => dumpRecord(readRecord(value)),
	SearchPage: (value) => {
		const page: SearchPage = readSearchPage(value);
		const paging = page.paging === null ? null : { next: page.paging.next === null ? null : { after: page.paging.next.after } };
		return { total: String(page.total), results: page.results.map(dumpRecord), paging };
	},
	Batch: (value) => {
		const batch: Batch = readBatch(value);
		return { results: batch.results.map(dumpRecord) };
	},
	Pipeline: (value) => dumpPipeline(readPipeline(value)),
	Pipelines: (value) => {
		const found: Pipelines = readPipelines(value);
		return { results: found.results.map(dumpPipeline) };
	},
};

/**
 * A response as the client reads it: "json" as `_read` does (`model_validate_json`, client.ts `#read`),
 * "python" as a write's answer is read (`json.loads`, then `model_validate`; ProviderHTTP.json, then the
 * model), or null when it does not fit.
 */
function reading(model: string, text: string, mode: "json" | "python" = "json"): JsonObject | null {
	const read = MODELS[model] as Reader<JsonObject>;
	try {
		return mode === "json" ? fromJsonText(read, text) : read(parseJson(text));
	} catch {
		return null;
	}
}

describe("responses, as the client's models read them", () => {
	test.each(vectors.responses.map((vector) => [`${vector.model} ${vector.text.slice(0, 80)}`, vector] as const))("%s", (_, vector) => {
		expect(reading(vector.model, vector.text, "json")).toEqual(vector.json_mode);
		expect(reading(vector.model, vector.text, "python")).toEqual(vector.python_mode);
	});

	test("a JSON number beyond 2^53 is refused where Python reads it exactly", () => {
		expect(reading("Details", '{"portalId": 9007199254740993}')).toBeNull();
		expect(reading("Details", '{"portalId": "9007199254740993"}')).toEqual({ portal_id: "9007199254740993", portal_name: null, ui_domain: null });
	});
});

describe("helpers", () => {
	const client = new HubSpotClient("t", settingsIo(async () => new Response(null, { status: 500 })));

	test("notes are escaped as html.escape does, with their line breaks", () => {
		for (const [body, html] of vectors.note_html) expect(noteHtml(body)).toBe(html);
	});

	test("search offsets", () => {
		for (const [value, limit, expected] of vectors.after) expect(failure(() => after(value, limit))).toEqual(expected);
	});

	test("the next page's offset, and searches cut at 10,000", () => {
		for (const [page, limit, expected] of vectors.following) expect(failure(() => following(client, readSearchPage(page), limit))).toEqual(expected);
	});

	test("record data cuts long fields by code point and flags them", () => {
		for (const vector of vectors.record_data) expect(recordData(readRecord(vector.record), vector.properties)).toEqual(vector.data);
	});

	test("pipelines list their stages in order, archived ones left out", () => {
		for (const vector of vectors.pipeline_data) expect(pipelineData(readPipeline(vector.pipeline))).toEqual(vector.data);
	});

	test("search bodies", () => {
		for (const vector of vectors.search_body) expect(searchBody(vector.options)).toEqual(vector.body);
	});

	test("errors named from HubSpot's category", () => {
		for (const [status, body, expected] of vectors.classify) {
			const error = classify("HubSpot", new Response(body, { status }), body);
			expect(error === null ? null : { code: error.code, message: error.message }).toEqual(expected);
		}
	});

	test("casefold is Python's", async () => {
		for (const [text, folded] of vectors.casefold) expect(casefold(text)).toBe(folded);
		const all: string[] = [];
		for (let point = 0; point < 0x110000; point++) if (point < 0xd800 || point > 0xdfff) all.push(casefold(String.fromCodePoint(point)));
		expect(await sha256Hex(canonicalAscii(all))).toBe(vectors.casefold_all);
	});
});
