// Xero's read operations: organisations, contacts, invoices and
// bills, accounts and tax rates.

import { z } from "zod";
import { OperationError, type Prepared, type ProviderOutput, defineOperation } from "../../gateway/connector.ts";
import type { ProviderRequest } from "../../gateway/http.ts";
import type { Json } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, truncate } from "../../lib/text.ts";
import { type Address, type Contact, type Invoice, type Invoices, type Outstanding, invoiceDate, moment, nextPage, page, uuid } from "./client.ts";
import { DATE_MESSAGE, parseDate } from "../../lib/dates.ts";
import { money, number } from "./decimal.ts";
import { ORGANISATION, client, invoiceId, label, optionalContactId, organisationId, organisationResource, resolveOrganisation, short } from "./organisations.ts";

export const MAX_DESCRIPTION = 2_000;
export const MAX_LINES = 200;
export const MAX_PAYMENTS = 50;
export const MAX_LISTED = 20;
export const NEXT_PAGE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor.";

type Fields = { [key: string]: Json };

const cursor = () => z.string().trim().max(1000).nullable().default(null);
const searchText = () => z.string().trim().min(1).max(100).refine(isSingleLine, SINGLE_LINE);
const limit = () => z.int().min(1).max(50).default(20);

export const OUT_OF_RANGE = "must be a date between the years 1900 and 2200";

/** A day, YYYY-MM-DD, between the years 1900 and 2200. */
export function day() {
	return z.string().trim().max(10)
		.describe("YYYY-MM-DD.")
		.refine((value) => parseDate(value) !== null, DATE_MESSAGE)
		.refine((value) => {
			const found = parseDate(value);
			return found === null || (found.year >= 1900 && found.year <= 2200);
		}, OUT_OF_RANGE);
}

/** Xero's types for sales invoices and bills. */
export const TYPES = { sales: "ACCREC", bill: "ACCPAY" } as const;
export type InvoiceKind = keyof typeof TYPES;

/** The kind of a Xero invoice type, or null. */
export function kindOf(type: string | null): InvoiceKind | null {
	if (type === TYPES.sales) return "sales";
	if (type === TYPES.bill) return "bill";
	return null;
}

const ListOrganisations = z.strictObject({});

export const LIST_ORGANISATIONS = defineOperation<z.output<typeof ListOrganisations>>({
	name: "list_organisations",
	title: "List organisations",
	description: "List the Xero organisations you may read.",
	input: ListOrganisations,
	needs: [[ORGANISATION, "read"]],
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: ORGANISATION, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const records = (await client(binding).organisations()).map((organisation) => ({
					resource: organisationResource(binding, organisation.tenantId),
					data: { id: organisation.tenantId, name: label(organisation) },
				}));
				return { records };
			},
		};
	},
});

function address(found: Address): Fields {
	const lines = [found.AddressLine1, found.AddressLine2, found.AddressLine3, found.AddressLine4];
	return {
		type: found.AddressType,
		lines: lines.filter((line) => short(line)).map((line) => short(line)),
		city: short(found.City),
		region: short(found.Region),
		postal_code: short(found.PostalCode),
		country: short(found.Country),
	};
}

function outstanding(found: Outstanding | null): Fields | null {
	if (found === null) return null;
	return { outstanding: money(found.Outstanding), overdue: money(found.Overdue) };
}

export function contactRecord(found: Contact): Fields {
	const balances = found.Balances;
	const phones = found.Phones.map((phone) => [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter((part) => part).join(" "));
	return {
		id: uuid(found.ContactID),
		name: short(found.Name),
		first_name: short(found.FirstName),
		last_name: short(found.LastName),
		email: short(found.EmailAddress),
		contact_number: short(found.ContactNumber),
		account_number: short(found.AccountNumber),
		status: found.ContactStatus,
		is_customer: found.IsCustomer,
		is_supplier: found.IsSupplier,
		default_currency: found.DefaultCurrency,
		tax_number: short(found.TaxNumber),
		// An address without lines, city or country says nothing.
		addresses: found.Addresses.map(address)
			.filter((shown) => (shown.lines as string[]).length > 0 || shown.city !== null || shown.country !== null)
			.slice(0, MAX_LISTED),
		phones: phones
			.map((phone) => short(phone))
			.filter((phone) => phone !== null)
			.slice(0, MAX_LISTED),
		people: found.ContactPersons.map((person) => ({
			name: short([person.FirstName, person.LastName].filter((part) => part).join(" ")),
			email: short(person.EmailAddress),
		})).slice(0, MAX_LISTED),
		balances: {
			receivable: balances ? outstanding(balances.AccountsReceivable) : null,
			payable: balances ? outstanding(balances.AccountsPayable) : null,
		},
	};
}

const SearchContacts = z
	.strictObject({
		organisation: organisationId(),
		text: searchText().nullable().default(null).describe("Words in the contact's name, contact number or email address."),
		include_archived: z.boolean().default(false),
		limit: limit(),
		cursor: cursor(),
	});

export const SEARCH_CONTACTS = defineOperation<z.output<typeof SearchContacts>>({
	name: "search_contacts",
	title: "Search contacts",
	description: `Find customers and suppliers in a Xero organisation, by name, contact number or email address, sorted by name. Balances are Xero's totals and name no currency; for amounts in one currency, search the contact's invoices. Bank details are left out. ${NEXT_PAGE}`,
	input: SearchContacts,
	needs: [[ORGANISATION, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const current = page(data.cursor);
				const found = await client(binding).contacts(tenant, { page: current, size: data.limit, text: data.text, archived: data.include_archived });
				const records = found.Contacts.map((contact) => ({ resource, data: contactRecord(contact) }));
				return { records, nextCursor: nextPage(found.pagination, current, found.Contacts.length, data.limit) };
			},
		};
	},
});

export function summary(found: Invoice): Fields {
	const contact = found.Contact;
	return {
		id: uuid(found.InvoiceID),
		type: kindOf(found.Type),
		number: short(found.InvoiceNumber),
		reference: short(found.Reference),
		contact: contact ? { id: uuid(contact.ContactID), name: short(contact.Name) } : null,
		status: found.Status,
		date: invoiceDate(found.DateString, found.Date),
		due_date: invoiceDate(found.DueDateString, found.DueDate),
		currency: found.CurrencyCode,
		sub_total: money(found.SubTotal),
		total_tax: money(found.TotalTax),
		total: money(found.Total),
		amount_due: money(found.AmountDue),
		amount_paid: money(found.AmountPaid),
		amount_credited: money(found.AmountCredited),
		sent_to_contact: found.SentToContact,
		updated: moment(found.UpdatedDateUTC),
	};
}

export const STATUSES = ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"] as const;

const SearchInvoices = z
	.strictObject({
		organisation: organisationId(),
		type: z.enum(["sales", "bill"]).nullable().default(null).describe("sales: invoices to customers; bill: bills from suppliers. Both when left out."),
		statuses: z.array(z.enum(STATUSES)).min(1).max(6).nullable().default(null),
		contact: optionalContactId(),
		text: searchText().nullable().default(null).describe("Text in the invoice number or reference."),
		date_from: day().nullable().default(null),
		date_to: day().nullable().default(null),
		limit: limit(),
		cursor: cursor(),
	});

type SearchInvoicesInput = z.output<typeof SearchInvoices>;
type Query = NonNullable<ProviderRequest["query"]>;

/** Xero's filter, built from checked values only: a type from a fixed list and parsed dates. */
export function where(data: Pick<SearchInvoicesInput, "type" | "date_from" | "date_to">): string | null {
	const terms: string[] = [];
	if (data.type !== null) terms.push(`Type=="${TYPES[data.type]}"`);
	for (const [field, operator] of [
		[data.date_from, ">="],
		[data.date_to, "<="],
	] as const) {
		if (field === null) continue;
		if (parseDate(field) === null) throw new TypeError("A date the input accepted no longer parses.");
		terms.push(`Date${operator}DateTime(${field.replaceAll("-", ",")})`);
	}
	return terms.join(" AND ") || null;
}

export function invoiceParams(data: SearchInvoicesInput, current: number): Query {
	const params: Query = { page: current, pageSize: data.limit, summaryOnly: "true", order: "Date DESC" };
	const filter = where(data);
	if (filter !== null) params.where = filter;
	if (data.statuses !== null && data.statuses.length > 0) params.Statuses = [...new Set(data.statuses)].join(",");
	if (data.contact !== null) params.ContactIDs = data.contact;
	if (data.text !== null) params.searchTerm = data.text;
	return params;
}

export const SEARCH_INVOICES = defineOperation<SearchInvoicesInput>({
	name: "search_invoices",
	title: "Search invoices and bills",
	description: `Find sales invoices and bills in a Xero organisation by type, status, contact, date and text in the number or reference, newest first. Amounts are decimal strings in the invoice's currency. ${NEXT_PAGE}`,
	input: SearchInvoices,
	needs: [[ORGANISATION, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		// The dates as they were sent, compared as text.
		if (data.date_from && data.date_to && data.date_from > data.date_to) throw new OperationError("INVALID_ARGUMENTS", "date_from must not be after date_to.");
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const current = page(data.cursor);
				let found: Invoices;
				try {
					found = await client(binding).invoices(tenant, invoiceParams(data, current), data.limit);
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED" && data.cursor !== null) {
						throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
					}
					throw error;
				}
				const records = found.Invoices.map((invoice) => ({ resource, data: summary(invoice) }));
				return { records, nextCursor: nextPage(found.pagination, current, found.Invoices.length, data.limit) };
			},
		};
	},
});

const GetInvoice = z.strictObject({ organisation: organisationId(), invoice: invoiceId() });

function lines(found: Invoice): Json[] {
	return found.LineItems.slice(0, MAX_LINES).map((item) => {
		const [description, cut] = truncate(item.Description || null, MAX_DESCRIPTION);
		return {
			description,
			description_truncated: cut,
			quantity: number(item.Quantity),
			unit_amount: number(item.UnitAmount),
			item_code: short(item.ItemCode),
			account_code: short(item.AccountCode),
			tax_type: short(item.TaxType),
			tax_amount: money(item.TaxAmount),
			line_amount: money(item.LineAmount),
			discount_rate: number(item.DiscountRate),
			discount_amount: money(item.DiscountAmount),
			tracking: item.Tracking.map((tracking) => ({ category: short(tracking.Name), option: short(tracking.Option) })).slice(0, MAX_LISTED),
		};
	});
}

export function invoiceRecord(found: Invoice): Fields {
	return {
		...summary(found),
		amounts_are: found.LineAmountTypes,
		lines: lines(found),
		line_count: found.LineItems.length,
		lines_truncated: found.LineItems.length > MAX_LINES,
		payments: found.Payments.slice(0, MAX_PAYMENTS).map((payment) => ({
			date: invoiceDate(null, payment.Date),
			amount: money(payment.Amount),
			reference: short(payment.Reference),
		})),
		payment_count: found.Payments.length,
		payments_truncated: found.Payments.length > MAX_PAYMENTS,
		has_attachments: found.HasAttachments,
	};
}

export const GET_INVOICE = defineOperation<z.output<typeof GetInvoice>>({
	name: "get_invoice",
	title: "Read an invoice or bill",
	description: `Read one sales invoice or bill in a Xero organisation: its totals, up to ${MAX_LINES} lines and up to ${MAX_PAYMENTS} payments. Amounts are decimal strings in the invoice's currency.`,
	input: GetInvoice,
	needs: [[ORGANISATION, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await client(binding).invoice(tenant, data.invoice);
				return { records: [{ resource, data: invoiceRecord(found) }] };
			},
		};
	},
});

const ListAccounts = z.strictObject({ organisation: organisationId() });

export const LIST_ACCOUNTS = defineOperation<z.output<typeof ListAccounts>>({
	name: "list_accounts",
	title: "List accounts",
	description:
		"List the active accounts in a Xero organisation's chart of accounts, with their codes and default tax types, for the lines of draft invoices and bills. Bank account numbers are left out.",
	input: ListAccounts,
	needs: [[ORGANISATION, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const records = (await client(binding).accounts(tenant)).map((account) => ({
					resource,
					data: {
						code: short(account.Code),
						name: short(account.Name),
						type: account.Type,
						class: account.Class,
						tax_type: short(account.TaxType),
						description: short(account.Description, 300),
					},
				}));
				return { records };
			},
		};
	},
});

const ListTaxRates = z.strictObject({ organisation: organisationId() });

export const LIST_TAX_RATES = defineOperation<z.output<typeof ListTaxRates>>({
	name: "list_tax_rates",
	title: "List tax rates",
	description:
		"List the active tax rates in a Xero organisation, as percentages, for the lines of draft invoices and bills. tax_type is the value lines take.",
	input: ListTaxRates,
	needs: [[ORGANISATION, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [resource, tenant] = await resolveOrganisation(binding, data.organisation);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const records = (await client(binding).taxRates(tenant)).map((rate) => ({
					resource,
					data: {
						tax_type: short(rate.TaxType),
						name: short(rate.Name),
						display_rate: number(rate.DisplayTaxRate),
						effective_rate: number(rate.EffectiveRate),
						for_sales: rate.CanApplyToRevenue,
						for_expenses: rate.CanApplyToExpenses,
						components: rate.TaxComponents.map((component) => ({
							name: short(component.Name),
							rate: number(component.Rate),
							compound: component.IsCompound,
							non_recoverable: component.IsNonRecoverable,
						})).slice(0, MAX_LISTED),
					},
				}));
				return { records };
			},
		};
	},
});
