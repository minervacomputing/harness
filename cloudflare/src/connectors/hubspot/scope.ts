// What HubSpot's operations share: the kind, where records sit, ids, and deals checked again.
//
// Records are one hierarchical kind. Contacts sit inside `contacts`, companies inside `companies`, and deals
// inside their pipeline, inside `deals`. Users choose among the collections and the pipelines, never single
// contacts or companies: HubSpot answers for a merged record under the id of the record it was merged into,
// so a grant on one contact could reach another, while every contact stays inside `contacts`. A deal can
// move between pipelines, so its pipeline is read again just before a deal is read or written, and a deal
// that moved is refused (`DEAL_MOVED`).

import { z } from "zod";
import type { Binding } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, truncate } from "../../lib/text.ts";
import { type HubSpotClient, MAX_SEARCH_RESULTS, PIPELINE_ID, RECORD_ID, SEARCH_AFTER } from "./client.ts";
import type { HubRecord, SearchPage } from "./models.ts";

export const RECORD = "record";
export const CONTACTS = "contacts";
export const COMPANIES = "companies";
export const DEALS = "deals";
export const COLLECTIONS: ReadonlyMap<string, string> = new Map([
	[CONTACTS, "All contacts"],
	[COMPANIES, "All companies"],
	[DEALS, "All deals"],
]);
export const PIPELINE_PREFIX = "pipeline:";

export const CONTACT_PROPERTIES: readonly string[] = [
	"email",
	"firstname",
	"lastname",
	"phone",
	"mobilephone",
	"company",
	"jobtitle",
	"city",
	"country",
	"lifecyclestage",
	"createdate",
	"lastmodifieddate",
];
export const COMPANY_PROPERTIES: readonly string[] = [
	"name",
	"domain",
	"industry",
	"phone",
	"city",
	"country",
	"numberofemployees",
	"annualrevenue",
	"lifecyclestage",
	"description",
	"createdate",
	"hs_lastmodifieddate",
];
export const DEAL_PROPERTIES: readonly string[] = [
	"dealname",
	"pipeline",
	"dealstage",
	"amount",
	"deal_currency_code",
	"closedate",
	"dealtype",
	"description",
	"hs_is_closed",
	"hs_is_closed_won",
	"createdate",
	"hs_lastmodifieddate",
];
export const MAX_TEXT = 500;
export const MAX_DESCRIPTION = 2000;

// Input fields (Pydantic's Annotated types). A constraint is a zod check, an AfterValidator a refinement
// whose message the model reads as the field's.

function recordId(what: string, source: string) {
	return z.string().trim().min(1).max(20)
		.refine((value) => RECORD_ID.test(value), { message: `must be a ${what} id from ${source}` })
		.describe(`A ${what} id from ${source}, such as 1234.`);
}

export const ContactId = () => recordId("contact", "search_contacts");
export const CompanyId = () => recordId("company", "search_companies");
export const DealId = () => recordId("deal", "search_deals");
export const PipelineId = () =>
	z.string().trim().min(1).max(100)
		.refine((value) => PIPELINE_ID.test(value), { message: "must be a pipeline id from list_pipelines" })
		.describe("A deal pipeline id from list_pipelines.");
export const StageId = () =>
	z.string().trim().min(1).max(100)
		.refine((value) => PIPELINE_ID.test(value), { message: "must be a stage id from list_pipelines" })
		.describe("A deal stage id from list_pipelines.");
/** A single line of text with these limits (`AfterValidator(single_line)`). */
export const Line = (min: number, max: number) => z.string().trim().min(min).max(max).refine(isSingleLine, { message: SINGLE_LINE });
export const Query = () => Line(1, 200);
export const Limit = () => z.int().min(1).max(50);
/** The run's own page token; the executor swaps it for HubSpot's before the call is prepared. */
export const Cursor = () => z.string().trim().max(200);

// Where records sit.

export function collection(binding: Binding, name: string): Resource {
	return binding.resource(RECORD, name);
}

export function contact(binding: Binding, contactId: string): Resource {
	return binding.resource(RECORD, `contact:${contactId}`, [CONTACTS]);
}

export function company(binding: Binding, companyId: string): Resource {
	return binding.resource(RECORD, `company:${companyId}`, [COMPANIES]);
}

export function pipeline(binding: Binding, pipelineId: string): Resource {
	return binding.resource(RECORD, `${PIPELINE_PREFIX}${pipelineId}`, [DEALS]);
}

export function deal(binding: Binding, pipelineId: string, dealId: string): Resource {
	return binding.resource(RECORD, `deal:${dealId}`, [`${PIPELINE_PREFIX}${pipelineId}`, DEALS]);
}

export function pipelineOf(client: HubSpotClient, found: HubRecord): string {
	const value = found.properties.get("pipeline");
	if (!value || !PIPELINE_ID.test(value)) throw client.unexpected();
	return value;
}

/** A deal named by the agent; one HubSpot does not have is refused like one not allowed. */
export async function fetchDeal(client: HubSpotClient, dealId: string, properties: readonly string[] | null = null): Promise<HubRecord> {
	try {
		return await client.record(DEALS, dealId, properties?.length ? properties : ["pipeline"]);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
}

/** The deal again, refused if it moved to another pipeline since it was authorized. */
export async function currentDeal(client: HubSpotClient, dealId: string, pipelineId: string, properties: readonly string[] | null = null): Promise<HubRecord> {
	const found = await fetchDeal(client, dealId, properties);
	if (found.id !== dealId || pipelineOf(client, found) !== pipelineId) {
		throw new OperationError("DEAL_MOVED", "The deal moved to another pipeline while this was being checked. Try again.");
	}
	return found;
}

/** The record's id and these properties, long ones cut (and flagged `<name>_truncated`). */
export function recordData(found: HubRecord, properties: readonly string[]): { [key: string]: Json } {
	const data: JsonObject = { id: found.id };
	for (const name of properties) {
		const limit = name === "description" ? MAX_DESCRIPTION : MAX_TEXT;
		const [value, cut] = truncate(found.properties.get(name), limit);
		data[name] = value;
		if (cut) data[`${name}_truncated`] = true;
	}
	return data;
}

/** HubSpot's offset for the next search page, from a page token the executor resolved. */
export function after(value: string | null, limit: number): string | null {
	if (value === null) return null;
	if (!SEARCH_AFTER.test(value) || Number(value) + limit > MAX_SEARCH_RESULTS) throw new OperationError("INVALID_CURSOR", "This cursor is not valid.");
	return value;
}

/** The next page's offset, and whether results were left out because a search stops at 10,000. */
export function following(client: HubSpotClient, page: SearchPage, limit: number): [string | null, boolean] {
	const offset = page.paging?.next?.after ?? null;
	if (offset === null) return [null, false];
	if (!SEARCH_AFTER.test(offset)) throw client.unexpected();
	if (Number(offset) + limit > MAX_SEARCH_RESULTS) return [null, true];
	return [offset, false];
}

export interface SearchOptions {
	query: string | null;
	filters: JsonObject[];
	properties: readonly string[];
	sort: string;
	limit: number;
	after: string | null;
}

export function searchBody(options: SearchOptions): JsonObject {
	const body: JsonObject = {
		limit: options.limit,
		properties: [...options.properties],
		sorts: [{ propertyName: options.sort, direction: "DESCENDING" }],
		filterGroups: options.filters.length ? [{ filters: options.filters }] : [],
	};
	if (options.query) body.query = options.query;
	if (options.after) body.after = options.after;
	return body;
}

export function equals(name: string, value: string): JsonObject {
	return { propertyName: name, operator: "EQ", value };
}
