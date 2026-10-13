// The HubSpot connector against what today's Python computes (test/fixtures/connectors/hubspot/vectors.json,
// written by generate.py beside it): every operation's input normalization and validation messages, with
// the query hashes and write keys of the normalized arguments, and the helpers whose words or arithmetic matter.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Operation } from "../../src/contracts/connectors.ts";
import { HubSpotClient, classify } from "../../src/connectors/hubspot/client.ts";
import { SCOPES, hubspotConnector } from "../../src/connectors/hubspot/connector.ts";
import { HubRecord, Pipeline, SearchPage } from "../../src/connectors/hubspot/models.ts";
import { pipelineData } from "../../src/connectors/hubspot/reads.ts";
import { type SearchOptions, after, following, recordData, searchBody } from "../../src/connectors/hubspot/scope.ts";
import { noteHtml } from "../../src/connectors/hubspot/writes.ts";
import { OperationError, operationOf, termsOf } from "../../src/gateway/connector.ts";
import { settingsIo } from "../../src/gateway/http.ts";
import { writeKey } from "../../src/gateway/ledger.ts";
import { inputSchema } from "../../src/gateway/registry.ts";
import { queryHash } from "../../src/gateway/page-tokens.ts";
import { validateInput } from "../../src/gateway/validation.ts";
import { changedOnPurpose } from "./changed.ts";
import { type Json, type JsonObject, parseJson } from "../../src/lib/json.ts";

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
	note_html: [string, string][];
	after: [string | null, number, string | null | Failure][];
	following: [JsonObject, number, [string | null, boolean] | Failure][];
	record_data: { record: JsonObject; properties: string[]; data: JsonObject }[];
	pipeline_data: { pipeline: JsonObject; data: JsonObject }[];
	search_body: { options: SearchOptions; body: JsonObject }[];
	classify: [number, string, Failure | null][];
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

	const inputs = vectors.inputs.filter((vector) => !changedOnPurpose(vector.raw));
	test.each(inputs.map((vector) => [`${vector.op} ${JSON.stringify(vector.raw).slice(0, 80)}`, vector] as const))("%s", async (_, vector) => {
		const operation = op(vector.op);
		const validated = await validateInput(operation.input, vector.raw);
		if (vector.dump !== undefined) {
			expect(validated).toEqual({ ok: true, data: vector.dump });
			if (!validated.ok) return;
			// Hashed over the normalized arguments, so a page token and a write key are those of Python's arguments.
			expect(await queryHash(validated.data)).toBe(await queryHash(vector.dump as JsonObject));
			if (operation.mutates) expect(await writeKey(`hubspot_${vector.op}`, validated.data)).toBe(await writeKey(`hubspot_${vector.op}`, vector.dump as JsonObject));
		} else if (vector.message !== undefined) {
			expect(validated).toMatchObject({ ok: false });
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

describe("helpers", () => {
	const client = new HubSpotClient("t", settingsIo(async () => new Response(null, { status: 500 })));

	test("notes are escaped as html.escape does, with their line breaks", () => {
		for (const [body, html] of vectors.note_html) expect(noteHtml(body)).toBe(html);
	});

	test("search offsets", () => {
		for (const [value, limit, expected] of vectors.after) expect(failure(() => after(value, limit))).toEqual(expected);
	});

	test("the next page's offset, and searches cut at 10,000", () => {
		for (const [page, limit, expected] of vectors.following) expect(failure(() => following(client, SearchPage.parse(page), limit))).toEqual(expected);
	});

	test("record data cuts long fields and flags them", () => {
		for (const vector of vectors.record_data) if (!changedOnPurpose(vector.record)) expect(recordData(HubRecord.parse(vector.record), vector.properties)).toEqual(vector.data);
	});

	test("pipelines list their stages in order, archived ones left out", () => {
		for (const vector of vectors.pipeline_data) expect(pipelineData(Pipeline.parse(vector.pipeline))).toEqual(vector.data);
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

});
