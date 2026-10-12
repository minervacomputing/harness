// HubSpot's write operations: contacts, deals and notes (ported from backend/connectors/hubspot/writes.py).
//
// A deal is created in a pipeline the agent names and may be associated with contacts and companies the
// agent may read. A deal is edited only within its pipeline: a stage must belong to it, and a deal that moved
// since it was authorized is refused. Notes are plain text, escaped into the HTML HubSpot stores, so a note
// cannot link, embed or format anything. HubSpot may itself create and associate a company for a new
// contact, from the domain of the contact's email address, when the account is set up that way.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, Requirement } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { isoDate } from "../../lib/isoformat.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { PLAIN_TEXT, isPlainText } from "../../lib/text.ts";
import { CONFLICT, type HubSpotClient, association } from "./client.ts";
import type { Pipeline } from "./models.ts";
import {
	CONTACT_PROPERTIES,
	CONTACTS,
	CompanyId,
	ContactId,
	DEAL_PROPERTIES,
	DEALS,
	DealId,
	Line,
	PipelineId,
	RECORD,
	StageId,
	collection,
	company,
	contact,
	currentDeal,
	deal,
	fetchDeal,
	pipeline,
	pipelineOf,
	recordData,
} from "./scope.ts";

export const MAX_ASSOCIATIONS = 10;
export const MAX_NOTE = 5000;
// HubSpot's own association types between a new record and an existing one.
export const DEAL_TO_CONTACT = 3;
export const DEAL_TO_COMPANY = 341;
export const NOTE_TO_CONTACT = 202;
export const NOTE_TO_COMPANY = 190;
export const NOTE_TO_DEAL = 214;
const AMOUNT = /^[0-9]{1,13}(?:\.[0-9]{1,2})?$/;

function clientOf(binding: Binding): HubSpotClient {
	return binding.client as HubSpotClient;
}

const text = (max: number, description: string) => Line(1, max).describe(description);

/** `date.fromisoformat(value).isoformat() == value`: exactly YYYY-MM-DD, a day of the proleptic Gregorian calendar from year 1. */
export function isIsoDate(value: string): boolean {
	return isoDate(value) === value;
}

const Email = () => text(254, "An email address.");
const Name = () => text(100, "A first or last name.");
const Phone = () => text(50, "A phone number.");
const CompanyName = () => text(200, "A company name, as text; it does not associate a company record.");
const JobTitle = () => text(200, "A job title.");
const DealName = () => text(200, "The deal's name.");
const Amount = () =>
	strippedStr({ max: 16 })
		.refine((value) => AMOUNT.test(value), { message: "must be a number such as 1500 or 1500.50, without a currency or separators" })
		.describe("The amount in the deal's currency (the account's currency for a new deal), such as 1500 or 1500.50.");
const CloseDate = () =>
	strippedStr({ max: 10 }).refine(isIsoDate, { message: "must be a date such as 2026-12-31" }).describe("The expected close date, such as 2026-12-31.");

function closeDate(value: string): string {
	return `${value}T00:00:00Z`;
}

/** The error with the operation's own words for a conflict. */
function conflict(error: OperationError, message: string): OperationError {
	return error.message === CONFLICT ? new OperationError(error.code, message) : error;
}

const CONTACT_FIELDS = ["email", "firstname", "lastname", "phone", "company", "jobtitle"] as const;

type ContactValues = { [name in (typeof CONTACT_FIELDS)[number]]?: string | null };

/** The contact's properties to send: the fields given, in this order. */
function contactProperties(data: ContactValues): { [name: string]: string } {
	const properties: { [name: string]: string } = {};
	for (const name of CONTACT_FIELDS) {
		const value = data[name];
		if (value !== null && value !== undefined) properties[name] = value;
	}
	return properties;
}

const contactFields = () => ({
	firstname: Name().nullable().default(null),
	lastname: Name().nullable().default(null),
	phone: Phone().nullable().default(null),
	company: CompanyName().nullable().default(null),
	jobtitle: JobTitle().nullable().default(null),
});

const CreateContact = z.strictObject({ ...contactFields(), email: Email() });

export const CREATE_CONTACT = defineOperation<z.output<typeof CreateContact>>({
	name: "create_contact",
	title: "Create a contact",
	description:
		"Create a contact. Email addresses are unique: search_contacts finds an existing one. HubSpot may " +
		"also create and associate a company from the email address's domain.",
	input: CreateContact,
	needs: [[RECORD, "create"]],
	outputAction: "create",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: collection(binding, CONTACTS), action: "create" }],
			async execute(): Promise<ProviderOutput> {
				let created: Awaited<ReturnType<HubSpotClient["create"]>>;
				try {
					created = await clientOf(binding).create(CONTACTS, contactProperties(data), []);
				} catch (error) {
					if (error instanceof OperationError) throw conflict(error, "A contact with this email address already exists.");
					throw error;
				}
				return { records: [{ resource: contact(binding, created.id), data: recordData(created, CONTACT_PROPERTIES) }] };
			},
		};
	},
});

const UpdateContact = z
	.strictObject({ ...contactFields(), contact_id: ContactId(), email: Email().nullable().default(null) })
	.refine((data) => Object.keys(contactProperties(data)).length > 0, { message: "give at least one field to change" });

export const UPDATE_CONTACT = defineOperation<z.output<typeof UpdateContact>>({
	name: "update_contact",
	title: "Update a contact",
	description: "Change a contact's email address, name, phone, company name or job title.",
	input: UpdateContact,
	needs: [[RECORD, "edit"]],
	outputAction: "edit",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: contact(binding, data.contact_id), action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				let updated: Awaited<ReturnType<HubSpotClient["update"]>>;
				try {
					updated = await clientOf(binding).update(CONTACTS, data.contact_id, contactProperties(data));
				} catch (error) {
					if (!(error instanceof OperationError)) throw error;
					if (error.code === "NOT_FOUND") throw denied();
					throw conflict(error, "Another contact already has this email address.");
				}
				// HubSpot answers with the properties changed.
				const changed = CONTACT_PROPERTIES.filter((name) => updated.properties.has(name));
				return { records: [{ resource: contact(binding, updated.id), data: recordData(updated, changed) }] };
			},
		};
	},
});

function stageIn(found: Pipeline, stageId: string): void {
	if (!found.stages.some((stage) => stage.id === stageId && !stage.archived)) {
		throw new OperationError("INVALID_STAGE", "This stage is not in the deal's pipeline. See list_pipelines.");
	}
}

async function openPipeline(client: HubSpotClient, pipelineId: string): Promise<Pipeline> {
	let found: Pipeline;
	try {
		found = await client.pipeline(pipelineId);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
	if (found.archived) throw new OperationError("PIPELINE_ARCHIVED", "This pipeline is archived. See list_pipelines.");
	return found;
}

const CreateDeal = z.strictObject({
	pipeline: PipelineId(),
	stage: StageId(),
	name: DealName(),
	amount: Amount().nullable().default(null),
	close_date: CloseDate().nullable().default(null),
	contact_ids: z.array(ContactId()).max(MAX_ASSOCIATIONS).default([]).describe("Contacts to associate with the deal."),
	company_ids: z.array(CompanyId()).max(MAX_ASSOCIATIONS).default([]).describe("Companies to associate with the deal."),
});

/** `list(dict.fromkeys(ids))`: the ids once each, in their first place. */
function unique(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

export const CREATE_DEAL = defineOperation<z.output<typeof CreateDeal>>({
	name: "create_deal",
	title: "Create a deal",
	description:
		"Create a deal in a pipeline and stage from list_pipelines, optionally associated with contacts " +
		"and companies. HubSpot workflows may act on new deals.",
	input: CreateDeal,
	needs: [
		[RECORD, "read"],
		[RECORD, "create"],
	],
	outputAction: "create",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const target = pipeline(binding, data.pipeline);
		const contactIds = unique(data.contact_ids);
		const companyIds = unique(data.company_ids);
		const requirements: Requirement[] = [
			{ need: target, action: "read" },
			{ need: target, action: "create" },
			...contactIds.map((id): Requirement => ({ need: contact(binding, id), action: "read" })),
			...companyIds.map((id): Requirement => ({ need: company(binding, id), action: "read" })),
		];
		return {
			requirements,
			async execute(): Promise<ProviderOutput> {
				stageIn(await openPipeline(client, data.pipeline), data.stage);
				const properties: { [name: string]: string } = { pipeline: data.pipeline, dealstage: data.stage, dealname: data.name };
				if (data.amount !== null) properties.amount = data.amount;
				if (data.close_date !== null) properties.closedate = closeDate(data.close_date);
				const associations = [...contactIds.map((id) => association(DEAL_TO_CONTACT, id)), ...companyIds.map((id) => association(DEAL_TO_COMPANY, id))];
				const created = await client.create(DEALS, properties, associations);
				// The deal sits where HubSpot put it, if HubSpot said.
				const placed = created.properties.get("pipeline") ? pipelineOf(client, created) : data.pipeline;
				return { records: [{ resource: deal(binding, placed, created.id), data: recordData(created, DEAL_PROPERTIES) }] };
			},
		};
	},
});

const UpdateDeal = z
	.strictObject({
		deal_id: DealId(),
		name: DealName().nullable().default(null),
		stage: StageId().nullable().default(null).describe("A stage of the deal's own pipeline."),
		amount: Amount().nullable().default(null),
		close_date: CloseDate().nullable().default(null),
	})
	.refine((data) => data.name !== null || data.stage !== null || data.amount !== null || data.close_date !== null, {
		message: "give at least one field to change",
	});

export const UPDATE_DEAL = defineOperation<z.output<typeof UpdateDeal>>({
	name: "update_deal",
	title: "Update a deal",
	description:
		"Change a deal's name, stage, amount or close date. The stage must be in the deal's own pipeline; " +
		"deals cannot be moved to another pipeline. HubSpot workflows may act on stage changes.",
	input: UpdateDeal,
	needs: [[RECORD, "edit"]],
	outputAction: "edit",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		const found = await fetchDeal(client, data.deal_id);
		const pipelineId = pipelineOf(client, found);
		return {
			requirements: [{ need: deal(binding, pipelineId, found.id), action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				await currentDeal(client, found.id, pipelineId);
				if (data.stage !== null) stageIn(await openPipeline(client, pipelineId), data.stage);
				const properties: { [name: string]: string } = {};
				if (data.name !== null) properties.dealname = data.name;
				if (data.stage !== null) properties.dealstage = data.stage;
				if (data.amount !== null) properties.amount = data.amount;
				if (data.close_date !== null) properties.closedate = closeDate(data.close_date);
				let updated: Awaited<ReturnType<HubSpotClient["update"]>>;
				try {
					updated = await client.update(DEALS, found.id, properties);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
					throw error;
				}
				// HubSpot answers with the properties changed, and a workflow may have moved the deal meanwhile:
				// the deal is read again, and returned only if allowed where it now is.
				let fresh: Awaited<ReturnType<typeof fetchDeal>>;
				try {
					fresh = await fetchDeal(client, updated.id, DEAL_PROPERTIES);
				} catch (error) {
					if (error instanceof OperationError) return { records: [] };
					throw error;
				}
				return { records: [{ resource: deal(binding, pipelineOf(client, fresh), fresh.id), data: recordData(fresh, DEAL_PROPERTIES) }] };
			},
		};
	},
});

const AddNote = z
	.strictObject({
		contact_id: ContactId().nullable().default(null).describe("The contact to log the note on."),
		company_id: CompanyId().nullable().default(null).describe("The company to log the note on."),
		deal_id: DealId().nullable().default(null).describe("The deal to log the note on."),
		body: strippedStr({ min: 1, max: MAX_NOTE }).refine(isPlainText, { message: PLAIN_TEXT }).describe("The note, as plain text."),
	})
	.refine((data) => [data.contact_id, data.company_id, data.deal_id].filter((value) => value !== null).length === 1, {
		message: "give exactly one of contact_id, company_id and deal_id",
	});

/** Python's `html.escape(text)`: `&`, `<`, `>`, `"` and `'` as character references. */
export function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** The note as HTML that only shows its text: escaped, with its line breaks kept. */
export function noteHtml(body: string): string {
	return htmlEscape(body.replaceAll("\r\n", "\n")).replaceAll("\n", "<br>");
}

/** `datetime.now(UTC).isoformat(timespec="milliseconds")` with "Z" for UTC. */
function timestamp(): string {
	return new Date().toISOString();
}

export const ADD_NOTE = defineOperation<z.output<typeof AddNote>>({
	name: "add_note",
	title: "Log a note",
	description: "Log a plain-text note on one contact, company or deal; it shows in the record's activity timeline.",
	input: AddNote,
	needs: [[RECORD, "note"]],
	outputAction: "note",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = clientOf(binding);
		let onDeal: [string, string] | null = null;
		let target: Resource;
		let link: JsonObject;
		if (data.contact_id !== null) {
			target = contact(binding, data.contact_id);
			link = association(NOTE_TO_CONTACT, data.contact_id);
		} else if (data.company_id !== null) {
			target = company(binding, data.company_id);
			link = association(NOTE_TO_COMPANY, data.company_id);
		} else {
			const found = await fetchDeal(client, data.deal_id as string);
			onDeal = [found.id, pipelineOf(client, found)];
			target = deal(binding, onDeal[1], found.id);
			link = association(NOTE_TO_DEAL, found.id);
		}
		return {
			requirements: [{ need: target, action: "note" }],
			async execute(): Promise<ProviderOutput> {
				if (onDeal) await currentDeal(client, ...onDeal);
				let created: Awaited<ReturnType<HubSpotClient["create"]>>;
				try {
					created = await client.create("notes", { hs_note_body: noteHtml(data.body), hs_timestamp: timestamp() }, [link]);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
					throw error;
				}
				const record: { [key: string]: Json } = { note_id: created.id, logged_on: target.id };
				return { records: [{ resource: target, data: record }] };
			},
		};
	},
});
