// HubSpot's CRM API, at a pinned date version, so response shapes do not change under Minerva (ported from
// backend/connectors/hubspot/client.py).
//
// Responses are validated before use (models.ts). HubSpot's errors carry a category: a token without a
// scope is `MISSING_SCOPES` (403), and a write that would duplicate a unique value (a contact's email
// address) is a conflict (409). HubSpot's own messages are never passed on, since they can quote record
// data.

import type { ProviderClient, ProviderIo, ProviderRequest } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, type JsonObject, parseJson } from "../../lib/json.ts";
import {
	type Details,
	type HubRecord,
	type Pipeline,
	type Reader,
	type SearchPage,
	fromJsonText,
	readBatch,
	readDetails,
	readPipeline,
	readPipelines,
	readRecord,
	readSearchPage,
} from "./models.ts";

export const API_URL = "https://api.hubapi.com";
export const VERSION = "2026-09";
export const OBJECTS = `/crm/objects/${VERSION}`;
export const PIPELINES = `/crm/pipelines/${VERSION}/deals`;
/** Record ids are positive integers; leading zeros are refused, so one record has one spelling. */
export const RECORD_ID = /^[1-9][0-9]{0,19}$/;
/** Pipeline and stage ids: "default", built-in names such as "closedwon", or numbers. */
export const PIPELINE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Search pages are numbered by offset; HubSpot returns at most 10,000 results for a search. */
export const SEARCH_AFTER = /^(0|[1-9][0-9]{0,4})$/;
export const MAX_SEARCH_RESULTS = 10_000;
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const MAX_PIPELINES = 100;
export const CONFLICT = "HubSpot refused this because it conflicts with an existing record.";

/**
 * What `response.json().get("category")` finds in an error's body, or undefined. `body` is the text
 * ProviderHTTP decoded, invalid UTF-8 replaced, where `json.loads` refuses invalid UTF-8 and reads UTF-16
 * and UTF-32 too, and parseJson refuses NaN and Infinity: for such a body (not HubSpot's JSON), a 403 is
 * worded by the status rather than by its category, or the other way round, and stays PROVIDER_FORBIDDEN.
 */
function category(body: string): Json | undefined {
	let data: Json;
	try {
		// As json.loads reads bytes: a byte order mark (U+FEFF) is skipped.
		data = parseJson(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
	} catch {
		return undefined;
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	return Object.hasOwn(data, "category") ? data.category : undefined;
}

/** Names HubSpot's errors that the status alone does not (ProviderHttpOptions `classify`). */
export function classify(_provider: string, response: Response, body: string): OperationError | null {
	if (response.status === 403 && category(body) === "MISSING_SCOPES") {
		return new OperationError(
			"PROVIDER_FORBIDDEN",
			"HubSpot did not give Minerva the access this needs. Reconnect HubSpot; if that does not help, the HubSpot app needs the scopes in Minerva's setup guide.",
		);
	}
	if (response.status === 409) return new OperationError("PROVIDER_REJECTED", CONFLICT);
	return null;
}

/** An association made with a new record, of one of HubSpot's own types. */
export function association(typeId: number, recordId: string): JsonObject {
	return { to: { id: recordId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] };
}

export class HubSpotClient implements ProviderClient {
	readonly #http: ProviderHTTP;

	constructor(token: string, io: ProviderIo, baseUrl: string = API_URL) {
		this.#http = new ProviderHTTP(io, { provider: "HubSpot", baseUrl, headers: { Authorization: `Bearer ${token}` }, classify });
	}

	close(): Promise<void> {
		return this.#http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.#http.unexpected(cause);
	}

	/**
	 * A read streamed up to 4 MiB and read as `model_validate_json` reads bytes: UTF-8, no byte order mark,
	 * no lone surrogate escape.
	 */
	async #read<T>(reader: Reader<T>, request: ProviderRequest): Promise<T> {
		const response = await this.#http.bounded(request, MAX_RESPONSE, new OperationError("RESPONSE_TOO_LARGE", "HubSpot's response was too large to read."));
		const bytes = new Uint8Array(await response.arrayBuffer());
		try {
			return fromJsonText(reader, fromUtf8Strict(bytes));
		} catch (error) {
			throw this.unexpected(error);
		}
	}

	/** A write's JSON answer read with `reader` (ProviderHTTP.parsed). */
	async #parsed<T>(reader: Reader<T>, request: ProviderRequest): Promise<T> {
		const data = await this.#http.json(request);
		try {
			return reader(data);
		} catch (error) {
			throw this.unexpected(error);
		}
	}

	#checked(record: HubRecord): HubRecord {
		if (!RECORD_ID.test(record.id)) throw this.unexpected();
		return record;
	}

	details(): Promise<Details> {
		return this.#read(readDetails, { method: "GET", path: `/account-info/${VERSION}/details` });
	}

	/**
	 * One record. HubSpot answers for a record merged into another with the other, so the id returned can
	 * differ from the one asked for.
	 */
	async record(objectType: string, recordId: string, properties: readonly string[]): Promise<HubRecord> {
		const found = await this.#read(readRecord, { method: "GET", path: `${OBJECTS}/${objectType}/${recordId}`, query: { properties: properties.join(",") } });
		return this.#checked(found);
	}

	async search(objectType: string, body: JsonObject): Promise<SearchPage> {
		const page = await this.#read(readSearchPage, { method: "POST", path: `${OBJECTS}/${objectType}/search`, json: body });
		for (const record of page.results) this.#checked(record);
		return page;
	}

	/** The records with these ids that exist; a read, though HubSpot takes it as a POST. */
	async batch(objectType: string, ids: readonly string[], properties: readonly string[]): Promise<HubRecord[]> {
		if (ids.length === 0) return [];
		const found = await this.#read(readBatch, {
			method: "POST",
			path: `${OBJECTS}/${objectType}/batch/read`,
			json: { properties: [...properties], inputs: ids.map((id) => ({ id })) },
		});
		return found.results.map((record) => this.#checked(record));
	}

	async pipelines(): Promise<Pipeline[]> {
		const found = await this.#read(readPipelines, { method: "GET", path: PIPELINES });
		if (found.results.length > MAX_PIPELINES) throw new OperationError("PROVIDER_LIMIT", "There are more deal pipelines than Minerva reads.");
		return found.results.filter((pipeline) => PIPELINE_ID.test(pipeline.id));
	}

	async pipeline(pipelineId: string): Promise<Pipeline> {
		const found = await this.#read(readPipeline, { method: "GET", path: `${PIPELINES}/${pipelineId}` });
		if (found.id !== pipelineId) throw this.unexpected();
		return found;
	}

	async create(objectType: string, properties: { [name: string]: string }, associations: JsonObject[]): Promise<HubRecord> {
		const created = await this.#parsed(readRecord, { method: "POST", path: `${OBJECTS}/${objectType}`, json: { properties, associations } });
		return this.#checked(created);
	}

	async update(objectType: string, recordId: string, properties: { [name: string]: string }): Promise<HubRecord> {
		const updated = await this.#parsed(readRecord, { method: "PATCH", path: `${OBJECTS}/${objectType}/${recordId}`, json: { properties } });
		return this.#checked(updated);
	}
}
