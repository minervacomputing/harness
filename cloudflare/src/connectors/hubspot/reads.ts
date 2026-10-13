// HubSpot's read operations: contacts, companies, deal pipelines and deals.
//
// Records carry no associated record ids. What is associated with what is found with a search filter, which
// needs Read on both sides: contacts of a company need Read on the contacts and on the company. HubSpot pages
// a search before Minerva filters it, so the place of allowed results would tell whether hidden ones match:
// a deal search narrowed by anything but a pipeline needs Read on all deals, or names a pipeline. Deal searches
// read the deals found again (a batch read), since HubSpot's search index lags behind changes and could still
// place a deal in the pipeline it left; the records returned are the fresh ones.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, Requirement, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import type { HubSpotClient } from "./client.ts";
import { type HubRecord, type Pipeline, byDisplayOrder } from "./models.ts";
import {
	COMPANIES,
	COMPANY_PROPERTIES,
	CONTACT_PROPERTIES,
	CONTACTS,
	CompanyId,
	ContactId,
	Cursor,
	DEAL_PROPERTIES,
	DEALS,
	DealId,
	Limit,
	Line,
	PipelineId,
	Query,
	RECORD,
	StageId,
	after,
	collection,
	company,
	contact,
	currentDeal,
	deal,
	equals,
	fetchDeal,
	following,
	pipeline,
	pipelineOf,
	recordData,
	searchBody,
} from "./scope.ts";

export const PAGE_NOTE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor.";
const NEEDS_READ: [string, string][] = [[RECORD, "read"]];

function clientOf(binding: Binding): HubSpotClient {
	return binding.client as HubSpotClient;
}

/** Read on a deal the agent named, with the deal's pipeline and the id HubSpot answered with. */
async function dealNeed(binding: Binding, dealId: string): Promise<[Requirement, string, string]> {
	const client = clientOf(binding);
	const found = await fetchDeal(client, dealId);
	const pipelineId = pipelineOf(client, found);
	return [{ need: deal(binding, pipelineId, found.id), action: "read" }, found.id, pipelineId];
}

async function fetchRecord(client: HubSpotClient, objectType: string, recordId: string, properties: readonly string[]): Promise<HubRecord> {
	try {
		return await client.record(objectType, recordId, properties);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
}

const SearchContacts = z.strictObject({
	query: Query().nullable().default(null).describe("Words to find in names, email addresses, phone numbers and company names."),
	email: Line(3, 254).nullable().default(null).describe("Only the contact with exactly this email address."),
	company_id: CompanyId().nullable().default(null).describe("Only contacts associated with this company."),
	deal_id: DealId().nullable().default(null).describe("Only contacts associated with this deal."),
	limit: Limit().default(10),
	cursor: Cursor().nullable().default(null),
});

export const SEARCH_CONTACTS = defineOperation<z.output<typeof SearchContacts>>({
	name: "search_contacts",
	title: "Search contacts",
	description:
		"Search contacts, most recently changed first: by words, by exact email address, or by the company " +
		"or deal they are associated with. HubSpot's search can lag a few seconds behind changes. " +
		PAGE_NOTE,
	input: SearchContacts,
	needs: NEEDS_READ,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const requirements: Requirement[] = [{ need: collection(binding, CONTACTS), action: "read" }];
		const filters: JsonObject[] = [];
		if (data.email) filters.push(equals("email", data.email));
		if (data.company_id) {
			requirements.push({ need: company(binding, data.company_id), action: "read" });
			filters.push(equals("associations.company", data.company_id));
		}
		let onDeal: [string, string] | null = null;
		if (data.deal_id) {
			const [need, dealId, pipelineId] = await dealNeed(binding, data.deal_id);
			requirements.push(need);
			filters.push(equals("associations.deal", dealId));
			onDeal = [dealId, pipelineId];
		}
		return {
			requirements,
			async execute(): Promise<ProviderOutput> {
				if (onDeal) await currentDeal(client, ...onDeal);
				const body = searchBody({
					query: data.query,
					filters,
					properties: CONTACT_PROPERTIES,
					sort: "lastmodifieddate",
					limit: data.limit,
					after: after(data.cursor, data.limit),
				});
				const page = await client.search(CONTACTS, body);
				const [nextCursor, incomplete] = following(client, page, data.limit);
				const records = page.results.map((found): ScopedRecord => ({ resource: contact(binding, found.id), data: recordData(found, CONTACT_PROPERTIES) }));
				return { records, nextCursor, incomplete };
			},
		};
	},
});

const GetContact = z.strictObject({ contact_id: ContactId() });

export const GET_CONTACT = defineOperation<z.output<typeof GetContact>>({
	name: "get_contact",
	title: "Get a contact",
	description: "Get one contact. A contact merged into another is answered with the other, under its own id.",
	input: GetContact,
	needs: NEEDS_READ,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: contact(binding, data.contact_id), action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await fetchRecord(clientOf(binding), CONTACTS, data.contact_id, CONTACT_PROPERTIES);
				return { records: [{ resource: contact(binding, found.id), data: recordData(found, CONTACT_PROPERTIES) }] };
			},
		};
	},
});

const SearchCompanies = z.strictObject({
	query: Query().nullable().default(null).describe("Words to find in names, domains, websites and phone numbers."),
	domain: Line(3, 253).nullable().default(null).describe("Only companies with exactly this domain, such as example.com."),
	contact_id: ContactId().nullable().default(null).describe("Only companies associated with this contact."),
	deal_id: DealId().nullable().default(null).describe("Only companies associated with this deal."),
	limit: Limit().default(10),
	cursor: Cursor().nullable().default(null),
});

export const SEARCH_COMPANIES = defineOperation<z.output<typeof SearchCompanies>>({
	name: "search_companies",
	title: "Search companies",
	description:
		"Search companies, most recently changed first: by words, by exact domain, or by the contact or " +
		`deal they are associated with. HubSpot's search can lag a few seconds behind changes. ${PAGE_NOTE}`,
	input: SearchCompanies,
	needs: NEEDS_READ,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const requirements: Requirement[] = [{ need: collection(binding, COMPANIES), action: "read" }];
		const filters: JsonObject[] = [];
		if (data.domain) filters.push(equals("domain", data.domain));
		if (data.contact_id) {
			requirements.push({ need: contact(binding, data.contact_id), action: "read" });
			filters.push(equals("associations.contact", data.contact_id));
		}
		let onDeal: [string, string] | null = null;
		if (data.deal_id) {
			const [need, dealId, pipelineId] = await dealNeed(binding, data.deal_id);
			requirements.push(need);
			filters.push(equals("associations.deal", dealId));
			onDeal = [dealId, pipelineId];
		}
		return {
			requirements,
			async execute(): Promise<ProviderOutput> {
				if (onDeal) await currentDeal(client, ...onDeal);
				const body = searchBody({
					query: data.query,
					filters,
					properties: COMPANY_PROPERTIES,
					sort: "hs_lastmodifieddate",
					limit: data.limit,
					after: after(data.cursor, data.limit),
				});
				const page = await client.search(COMPANIES, body);
				const [nextCursor, incomplete] = following(client, page, data.limit);
				const records = page.results.map((found): ScopedRecord => ({ resource: company(binding, found.id), data: recordData(found, COMPANY_PROPERTIES) }));
				return { records, nextCursor, incomplete };
			},
		};
	},
});

const GetCompany = z.strictObject({ company_id: CompanyId() });

export const GET_COMPANY = defineOperation<z.output<typeof GetCompany>>({
	name: "get_company",
	title: "Get a company",
	description: "Get one company. A company merged into another is answered with the other, under its own id.",
	input: GetCompany,
	needs: NEEDS_READ,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: company(binding, data.company_id), action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await fetchRecord(clientOf(binding), COMPANIES, data.company_id, COMPANY_PROPERTIES);
				return { records: [{ resource: company(binding, found.id), data: recordData(found, COMPANY_PROPERTIES) }] };
			},
		};
	},
});

/** A pipeline with its stages in order, archived ones left out. */
export function pipelineData(found: Pipeline): { [key: string]: Json } {
	const stages = byDisplayOrder(found.stages.filter((stage) => !stage.archived));
	return {
		id: found.id,
		label: found.label,
		stages: stages.map((stage) => ({
			id: stage.id,
			label: stage.label,
			probability: stage.metadata.get("probability") ?? null,
			closed: stage.metadata.get("isClosed") === "true",
		})),
	};
}

const ListPipelines = z.strictObject({});

export const LIST_PIPELINES = defineOperation<z.output<typeof ListPipelines>>({
	name: "list_pipelines",
	title: "List deal pipelines",
	description: "List the deal pipelines you may see, with their stages in order.",
	input: ListPipelines,
	needs: NEEDS_READ,
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: RECORD, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await clientOf(binding).pipelines();
				const ordered = byDisplayOrder(found.filter((item) => !item.archived));
				return { records: ordered.map((item) => ({ resource: pipeline(binding, item.id), data: pipelineData(item) })) };
			},
		};
	},
});

const SearchDeals = z.strictObject({
	pipeline: PipelineId()
		.nullable()
		.default(null)
		.describe("Only deals in this pipeline. Searching by stage, words, contact or company needs a pipeline unless all deals may be read."),
	stage: StageId().nullable().default(null).describe("Only deals in this stage."),
	query: Query().nullable().default(null).describe("Words to find in deal names, descriptions, stages and types."),
	contact_id: ContactId().nullable().default(null).describe("Only deals associated with this contact."),
	company_id: CompanyId().nullable().default(null).describe("Only deals associated with this company."),
	limit: Limit().default(10),
	cursor: Cursor().nullable().default(null),
});

export const SEARCH_DEALS = defineOperation<z.output<typeof SearchDeals>>({
	name: "search_deals",
	title: "Search deals",
	description:
		"Search deals, most recently changed first: by pipeline, stage, words, or the contact or company " +
		"they are associated with. Stages are ids from list_pipelines. Without a pipeline, only a search " +
		"with no other filter covers deals in single allowed pipelines. HubSpot's search can lag a few " +
		`seconds behind changes. ${PAGE_NOTE}`,
	input: SearchDeals,
	needs: NEEDS_READ,
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const filters: JsonObject[] = [];
		const requirements: Requirement[] = [];
		if (data.pipeline) {
			requirements.push({ need: pipeline(binding, data.pipeline), action: "read" });
			filters.push(equals("pipeline", data.pipeline));
		} else if (data.stage || data.query || data.contact_id || data.company_id) {
			// HubSpot pages before Minerva filters, so which allowed deals come back where would tell whether
			// hidden deals match too. Across pipelines, a narrowed search needs Read on all deals.
			requirements.push({ need: collection(binding, DEALS), action: "read" });
		} else {
			requirements.push({ enumerate: RECORD, action: "read" });
		}
		if (data.stage) filters.push(equals("dealstage", data.stage));
		if (data.contact_id) {
			requirements.push({ need: contact(binding, data.contact_id), action: "read" });
			filters.push(equals("associations.contact", data.contact_id));
		}
		if (data.company_id) {
			requirements.push({ need: company(binding, data.company_id), action: "read" });
			filters.push(equals("associations.company", data.company_id));
		}
		return {
			requirements,
			async execute(): Promise<ProviderOutput> {
				const body = searchBody({
					query: data.query,
					filters,
					properties: ["pipeline"],
					sort: "hs_lastmodifieddate",
					limit: data.limit,
					after: after(data.cursor, data.limit),
				});
				const page = await client.search(DEALS, body);
				const [nextCursor, incomplete] = following(client, page, data.limit);
				// By id; should HubSpot answer an id twice, the last answer counts.
				const fresh = new Map<string, HubRecord>();
				const ids = page.results.map((found) => found.id);
				for (const found of await client.batch(DEALS, ids, DEAL_PROPERTIES)) fresh.set(found.id, found);
				const records: ScopedRecord[] = [];
				for (const found of page.results) {
					const current = fresh.get(found.id);
					if (current === undefined || current.archived) continue;
					records.push({ resource: deal(binding, pipelineOf(client, current), found.id), data: recordData(current, DEAL_PROPERTIES) });
				}
				return { records, nextCursor, incomplete };
			},
		};
	},
});

const GetDeal = z.strictObject({ deal_id: DealId() });

export const GET_DEAL = defineOperation<z.output<typeof GetDeal>>({
	name: "get_deal",
	title: "Get a deal",
	description: "Get one deal: its pipeline, stage, amount, close date and description.",
	input: GetDeal,
	needs: NEEDS_READ,
	async prepare(binding, data): Promise<Prepared> {
		const [need, dealId, pipelineId] = await dealNeed(binding, data.deal_id);
		return {
			requirements: [need],
			async execute(): Promise<ProviderOutput> {
				const found = await currentDeal(clientOf(binding), dealId, pipelineId, DEAL_PROPERTIES);
				return { records: [{ resource: deal(binding, pipelineId, found.id), data: recordData(found, DEAL_PROPERTIES) }] };
			},
		};
	},
});
