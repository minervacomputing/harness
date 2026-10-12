// Xero's write operations, ported from backend/connectors/xero/writes.py: draft sales invoices and draft bills.
//
// Both create one invoice with status DRAFT, which Xero neither sends nor posts to the accounts: a person
// approves it in Xero. Nothing else is written. The request is built field by field from checked input, the
// status is fixed, the contact is named by id only (a contact named by name would be created), and it is sent
// with PUT, which only creates (POST would update an invoice it matches). The contact is read first, after the
// organisation is authorized: it must exist and be active.
//
// Amounts are taken as decimal strings and sent as JSON numbers. They have at most 14 significant digits, and
// the number's text is the decimal itself: it is written from the checked string (decimal.ts), never through
// a float.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine } from "../../lib/text.ts";
import { type Contact, type Invoice, invoiceDate, messages, uuid } from "./client.ts";
import { type Decimal, type JsonBody, JsonNumber, compare, isZero, jsonText, money, number, parsePlain, plain } from "./decimal.ts";
import { ORGANISATION, client, contactId, organisationId, resolveOrganisation, short } from "./organisations.ts";
import { type InvoiceKind, TYPES, day, kindOf } from "./reads.ts";

export const MAX_LINES = 100;
export const WRITE_CONSENT: string[][] = [["accounting.invoices"]];
/** Xero's line amount types: whether unit amounts include tax. */
export const AMOUNTS = { exclusive: "Exclusive", inclusive: "Inclusive", no_tax: "NoTax" } as const;

export const NOT_A_DECIMAL = "must be a decimal number written like 12.50";
const HUNDRED: Decimal = { negative: false, digits: "100", exponent: 0 };

interface Bounds {
	positive?: boolean;
	most?: Decimal;
}

/** writes.py `_decimal`: the value checked against `pattern` and the bounds, written without trailing zeros, or why it is refused. */
export function checkedDecimal(value: string, pattern: RegExp, bounds: Bounds = {}): { value: string } | { problem: string } {
	const found = pattern.test(value) ? parsePlain(value) : null;
	if (found === null) return { problem: NOT_A_DECIMAL };
	if (bounds.positive && (isZero(found) || found.negative)) return { problem: "must be more than 0" };
	if (bounds.most !== undefined && compare(found, bounds.most) > 0) return { problem: `must be at most ${plain(bounds.most)}` };
	return { value: number(found) };
}

/** `AfterValidator(_decimal(...))`: a refusal is the validator's ValueError, "Value error, ...". */
function decimalField(pattern: RegExp, bounds: Bounds = {}) {
	return (value: string, ctx: Pick<z.RefinementCtx, "issues">): string => {
		const checked = checkedDecimal(value, pattern, bounds);
		if ("value" in checked) return checked.value;
		ctx.issues.push({ code: "custom", message: checked.problem, input: value });
		return z.NEVER;
	};
}

const QUANTITY = /^[0-9]{1,9}(\.[0-9]{1,4})?$/;
const UNIT_AMOUNT = /^-?[0-9]{1,10}(\.[0-9]{1,4})?$/;
const DISCOUNT_RATE = /^[0-9]{1,3}(\.[0-9]{1,2})?$/;

const quantity = () =>
	strippedStr({ min: 1, max: 15 })
		.describe("A decimal string, more than 0, up to 4 decimal places.")
		.transform(decimalField(QUANTITY, { positive: true }));
const unitAmount = () =>
	strippedStr({ min: 1, max: 16 })
		.describe("A decimal string, up to 4 decimal places; negative for a discount line.")
		.transform(decimalField(UNIT_AMOUNT));
/** `DiscountRate | None = None`, defaulted before the transform so the JSON Schema shows the default. */
const discountRate = () => {
	const check = decimalField(DISCOUNT_RATE, { most: HUNDRED });
	return strippedStr({ min: 1, max: 6 })
		.describe("A percentage, 0 to 100, as a decimal string.")
		.nullable()
		.default(null)
		.transform((value, ctx) => (value === null ? null : check(value, ctx)));
};
const code = () => strippedStr({ min: 1, max: 50 }).refine(isSingleLine, SINGLE_LINE);
const description = () => strippedStr({ min: 1, max: 4000 }).refine(isPlainText, PLAIN_TEXT);
const reference = () => strippedStr({ min: 1, max: 255 }).refine(isSingleLine, SINGLE_LINE);
const currency = () =>
	strippedStr()
		.regex(/^[A-Z]{3}$/)
		.describe("An ISO 4217 code, such as EUR.");

function lineFields() {
	return {
		description: description(),
		quantity: quantity(),
		unit_amount: unitAmount(),
		account_code: code().nullable().default(null).describe("An account's code, from list_accounts."),
		tax_type: code().nullable().default(null).describe("A tax rate's tax_type, from list_tax_rates."),
		item_code: code().nullable().default(null).describe("An item's code in Xero."),
	};
}

const Line = z.strictObject(lineFields()).meta({ title: "Line" });
const SalesLine = z.strictObject({ ...lineFields(), discount_rate: discountRate() }).meta({ title: "SalesLine" });

function draftFields() {
	return {
		organisation: organisationId(),
		contact: contactId(),
		date: day().nullable().default(null).describe("YYYY-MM-DD; Xero uses today when left out."),
		due_date: day().nullable().default(null).describe("YYYY-MM-DD; the contact's or organisation's terms when left out."),
		currency: currency().nullable().default(null),
		amounts_are: z
			.enum(["exclusive", "inclusive", "no_tax"])
			.default("exclusive")
			.describe("Whether unit amounts exclude tax, include it, or carry none."),
	};
}

export const DraftInvoice = z
	.strictObject({
		...draftFields(),
		lines: z.array(SalesLine).min(1).max(MAX_LINES),
		number: reference().nullable().default(null).describe("The invoice number; Xero numbers it in sequence when left out."),
		reference: reference().nullable().default(null),
	})
	.meta({ title: "DraftInvoice" });
export type DraftInvoice = z.output<typeof DraftInvoice>;

export const DraftBill = z
	.strictObject({
		...draftFields(),
		lines: z.array(Line).min(1).max(MAX_LINES),
		number: reference().nullable().default(null).describe("The supplier's invoice number, shown in Xero as the bill's reference."),
	})
	.meta({ title: "DraftBill" });
export type DraftBill = z.output<typeof DraftBill>;

type LineInput = DraftBill["lines"][number] | DraftInvoice["lines"][number];

/** A checked decimal string as the JSON number Xero takes. */
function amount(value: string): JsonNumber {
	const found = parsePlain(value);
	if (found === null) throw new TypeError("An amount the input accepted is not a decimal.");
	return new JsonNumber(found);
}

function line(item: LineInput): { [key: string]: JsonBody } {
	const out: { [key: string]: JsonBody } = {
		Description: item.description,
		Quantity: amount(item.quantity),
		UnitAmount: amount(item.unit_amount),
	};
	if (item.account_code !== null) out.AccountCode = item.account_code;
	if (item.tax_type !== null) out.TaxType = item.tax_type;
	if (item.item_code !== null) out.ItemCode = item.item_code;
	// A sales line (SalesLine) may carry a discount; a bill's line has no such field.
	if ("discount_rate" in item && item.discount_rate !== null) out.DiscountRate = amount(item.discount_rate);
	return out;
}

/** The invoice sent to Xero: only these fields, and always a draft. */
export function body(data: DraftInvoice | DraftBill, kind: InvoiceKind): { [key: string]: JsonBody } {
	const invoice: { [key: string]: JsonBody } = {
		Type: TYPES[kind],
		Status: "DRAFT",
		Contact: { ContactID: data.contact },
		LineAmountTypes: AMOUNTS[data.amounts_are],
		LineItems: data.lines.map(line),
	};
	if (data.date !== null) invoice.Date = data.date;
	if (data.due_date !== null) invoice.DueDate = data.due_date;
	if (data.currency !== null) invoice.CurrencyCode = data.currency;
	if (data.number !== null) invoice.InvoiceNumber = data.number;
	// Only a sales invoice (DraftInvoice) has a reference of its own.
	if ("reference" in data && data.reference !== null) invoice.Reference = data.reference;
	return invoice;
}

export function createdRecord(created: Invoice): { [key: string]: Json } {
	const contact = created.Contact;
	return {
		created: true,
		id: uuid(created.InvoiceID),
		type: kindOf(created.Type),
		status: created.Status,
		number: short(created.InvoiceNumber),
		reference: short(created.Reference),
		contact: contact ? { id: uuid(contact.ContactID), name: short(contact.Name) } : null,
		date: invoiceDate(created.DateString, created.Date),
		due_date: invoiceDate(created.DueDateString, created.DueDate),
		currency: created.CurrencyCode,
		sub_total: money(created.SubTotal),
		total_tax: money(created.TotalTax),
		total: money(created.Total),
		warnings: messages(created.Warnings),
	};
}

function prepareDraft(kind: InvoiceKind, action: string) {
	return async (binding: Binding, data: DraftInvoice | DraftBill): Promise<Prepared> => {
		// The dates as they were sent, compared as text, as today.
		if (data.date && data.due_date && data.due_date < data.date) throw new OperationError("INVALID_ARGUMENTS", "due_date must not be before date.");
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action }],
			async execute(): Promise<ProviderOutput> {
				const xero = client(binding);
				let contact: Contact;
				try {
					contact = await xero.contact(tenant, data.contact);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") {
						throw new OperationError("INVALID_ARGUMENTS", "This organisation has no contact with that id.");
					}
					throw error;
				}
				if (contact.ContactStatus !== "ACTIVE") throw new OperationError("INVALID_ARGUMENTS", "This contact is archived in Xero.");
				const created = await xero.createInvoice(tenant, jsonBody(data, kind));
				if (created.Status !== "DRAFT" || created.Type !== TYPES[kind] || created.Contact === null || uuid(created.Contact.ContactID) !== data.contact) {
					// The request asked for a draft for this contact; anything else is Xero's doing. The record shows
					// what Xero created, inside the organisation the call was allowed to write.
					console.error(`Xero answered a draft ${kind} with status ${created.Status}, type ${created.Type}`);
				}
				return { records: [{ resource, data: createdRecord(created) }] };
			},
		};
	};
}

/** The request's JSON text: `{"Invoices": [body]}`, compact, amounts as their decimals. */
export function jsonBody(data: DraftInvoice | DraftBill, kind: InvoiceKind): string {
	return jsonText({ Invoices: [body(data, kind)] });
}

export const WRITE_NOTE =
	"Xero neither sends drafts nor posts them to the accounts; a person reviews and approves them in Xero. A draft is not deduplicated across runs.";

export const CREATE_DRAFT_INVOICE = defineOperation<DraftInvoice>({
	name: "create_draft_invoice",
	title: "Create a draft sales invoice",
	description: `Create a draft sales invoice to a customer in a Xero organisation where you may draft sales invoices. Lines take an account code and tax type from list_accounts and list_tax_rates, or the defaults of their item, contact or organisation. ${WRITE_NOTE}`,
	input: DraftInvoice,
	needs: [[ORGANISATION, "draft_sales"]],
	prepare: prepareDraft("sales", "draft_sales"),
	consent: WRITE_CONSENT,
	mutates: true,
});

export const CREATE_DRAFT_BILL = defineOperation<DraftBill>({
	name: "create_draft_bill",
	title: "Create a draft bill",
	description: `Create a draft bill from a supplier in a Xero organisation where you may draft bills. Lines take an account code and tax type from list_accounts and list_tax_rates, or the defaults of their item, contact or organisation. ${WRITE_NOTE}`,
	input: DraftBill,
	needs: [[ORGANISATION, "draft_bills"]],
	prepare: prepareDraft("bill", "draft_bills"),
	consent: WRITE_CONSENT,
	mutates: true,
});
