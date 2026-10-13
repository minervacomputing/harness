// Stripe's read operations: customers, and the payments, invoices and subscriptions billed to them.

import { z } from "zod";
import type { Binding, Prepared, ProviderOutput, Requirement, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, truncate } from "../../lib/text.ts";
import { CUSTOMER_ID, type Charge, type Customer, type Invoice, type Page, type StripeClient, type Subscription, nextCursor } from "./client.ts";
import * as money from "./money.ts";
import { CUSTOMER, billed, cursor, customer, customerId, pageCursor } from "./scope.ts";

export const MAX_TEXT = 500;
export const PAGE_NOTE = "To get the next page, repeat the call with identical arguments plus the returned next_cursor.";

type Fields = { [key: string]: Json };

const limit = () => z.int().min(1).max(25).default(10);

function amountOf(minor: number | bigint | null, currency: string | null): string | null {
	if (minor === null || currency === null) return null;
	return money.major(minor, currency.toLowerCase());
}

/** A long text cut, and flagged as `<name>_truncated`. */
function textInto(record: Fields, name: string, value: string | null): void {
	const [kept, cut] = truncate(value, MAX_TEXT);
	record[name] = kept;
	if (cut) record[`${name}_truncated`] = true;
}

export function customerData(found: Customer): Fields {
	const record: Fields = {
		id: found.id,
		name: found.name,
		email: found.email,
		currency: found.currency,
		// Negative is credit the customer has with you; positive is what they owe on their next invoice.
		balance: found.currency ? amountOf(found.balance, found.currency) : null,
		delinquent: found.delinquent,
		created: found.created,
	};
	textInto(record, "description", found.description);
	return record;
}

export function chargeData(found: Charge): Fields {
	const currency = found.currency;
	const card = found.payment_method_details ? found.payment_method_details.card : null;
	const billing = found.billing_details;
	// As BigInt, so the difference of two integers Stripe sent is exact whatever their size.
	const refundable = found.status === "succeeded" ? BigInt(found.amount_captured) - BigInt(found.amount_refunded) : 0n;
	const record: Fields = {
		id: found.id,
		customer: found.customer,
		amount: amountOf(found.amount, currency),
		amount_captured: amountOf(found.amount_captured, currency),
		amount_refunded: amountOf(found.amount_refunded, currency),
		refundable: amountOf(refundable > 0n ? refundable : 0n, currency),
		currency,
		status: found.status,
		captured: found.captured,
		refunded: found.refunded,
		disputed: found.disputed,
		created: found.created,
		payment_intent: found.payment_intent,
		payment_method: found.payment_method_details ? found.payment_method_details.type : null,
		card_brand: card ? card.brand : null,
		card_last4: card ? card.last4 : null,
		billing_name: billing ? billing.name : null,
		billing_email: billing ? billing.email : null,
		failure_code: found.failure_code,
	};
	textInto(record, "description", found.description);
	textInto(record, "failure_message", found.failure_message);
	return record;
}

export function invoiceData(found: Invoice): Fields {
	const currency = found.currency;
	const record: Fields = {
		id: found.id,
		customer: found.customer,
		number: found.number,
		status: found.status,
		currency,
		total: amountOf(found.total, currency),
		amount_due: amountOf(found.amount_due, currency),
		amount_paid: amountOf(found.amount_paid, currency),
		amount_remaining: amountOf(found.amount_remaining, currency),
		created: found.created,
		due_date: found.due_date,
	};
	textInto(record, "description", found.description);
	return record;
}

export function subscriptionData(found: Subscription): Fields {
	const items: Json[] = found.items.data.slice(0, 20).map((item) => {
		const price = item.price;
		return {
			price: price ? price.id : null,
			nickname: price ? price.nickname : null,
			product: price ? price.product : null,
			unit_amount: price ? amountOf(price.unit_amount, price.currency) : null,
			currency: price ? price.currency : null,
			interval: price && price.recurring ? price.recurring.interval : null,
			interval_count: price && price.recurring ? price.recurring.interval_count : null,
			quantity: item.quantity,
			current_period_end: item.current_period_end,
		};
	});
	return {
		id: found.id,
		customer: found.customer,
		status: found.status,
		currency: found.currency,
		created: found.created,
		cancel_at_period_end: found.cancel_at_period_end,
		cancel_at: found.cancel_at,
		canceled_at: found.canceled_at,
		items,
	};
}

function billedOutput<T extends { id: string; customer: string | null }>(binding: Binding, page: Page<T>, data: (item: T) => Fields): ProviderOutput {
	const records: ScopedRecord[] = page.data.map((item) => ({ resource: billed(binding, item.id, item.customer), data: data(item) }));
	return { records, nextCursor: nextCursor(page) };
}

function scopeOf(binding: Binding, customerId: string | null): Requirement[] {
	if (customerId === null) return [{ enumerate: CUSTOMER, action: "read" }];
	return [{ need: customer(binding, customerId), action: "read" }];
}

const ListCustomers = z.strictObject({
	email: z.string().trim().min(3).max(512)
		.refine(isSingleLine, SINGLE_LINE)
		.nullable()
		.default(null)
		.describe("Only customers with exactly this email address. Only one page is returned."),
	limit: limit(),
	cursor: pageCursor(),
});

export const LIST_CUSTOMERS = defineOperation<z.output<typeof ListCustomers>>({
	name: "list_customers",
	title: "List customers",
	description: `List the customers you may see, newest first, with their contact details and balance (negative is credit they have, positive is what they owe). ${PAGE_NOTE}`,
	input: ListCustomers,
	needs: [[CUSTOMER, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		return {
			requirements: [{ enumerate: CUSTOMER, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const page = await client.customers({ email: data.email, limit: data.limit, cursor: cursor(data.cursor) });
				const records = page.data
					.filter((found) => !found.deleted && CUSTOMER_ID.test(found.id))
					.map((found) => ({ resource: customer(binding, found.id), data: customerData(found) }));
				// A next page of customers all filtered out would tell an agent that hidden customers have the
				// address, so a lookup by address returns one page.
				return { records, nextCursor: data.email ? null : nextCursor(page) };
			},
		};
	},
});

const GetCustomer = z.strictObject({ customer: customerId() });

export const GET_CUSTOMER = defineOperation<z.output<typeof GetCustomer>>({
	name: "get_customer",
	title: "Get a customer",
	description: "Get one customer: contact details, currency, balance and whether they are delinquent.",
	input: GetCustomer,
	needs: [[CUSTOMER, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		const resource = customer(binding, data.customer);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				let found: Customer;
				try {
					found = await client.customer(data.customer);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
					throw error;
				}
				if (found.deleted) throw denied();
				return { records: [{ resource, data: customerData(found) }] };
			},
		};
	},
});

const ListPayments = z.strictObject({
	customer: customerId().nullable().default(null).describe("Only this customer's payments."),
	limit: limit(),
	cursor: pageCursor(),
});

export const LIST_PAYMENTS = defineOperation<z.output<typeof ListPayments>>({
	name: "list_payments",
	title: "List payments",
	description: `List payments (charges), newest first: amounts in the currency's usual unit, what was refunded and what is left to refund, status, dispute, card brand and last four digits. Payments without a customer are shown only when every customer may be seen. ${PAGE_NOTE}`,
	input: ListPayments,
	needs: [[CUSTOMER, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		return {
			requirements: scopeOf(binding, data.customer),
			async execute(): Promise<ProviderOutput> {
				const page = await client.charges({ customer: data.customer, limit: data.limit, cursor: cursor(data.cursor) });
				return billedOutput(binding, page, chargeData);
			},
		};
	},
});

const ListInvoices = z.strictObject({
	customer: customerId().nullable().default(null).describe("Only this customer's invoices."),
	status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullable().default(null),
	limit: limit(),
	cursor: pageCursor(),
});

export const LIST_INVOICES = defineOperation<z.output<typeof ListInvoices>>({
	name: "list_invoices",
	title: "List invoices",
	description: `List invoices, newest first, with their status and amounts due, paid and remaining. ${PAGE_NOTE}`,
	input: ListInvoices,
	needs: [[CUSTOMER, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		return {
			requirements: scopeOf(binding, data.customer),
			async execute(): Promise<ProviderOutput> {
				const page = await client.invoices({ customer: data.customer, status: data.status, limit: data.limit, cursor: cursor(data.cursor) });
				return billedOutput(binding, page, invoiceData);
			},
		};
	},
});

const ListSubscriptions = z.strictObject({
	customer: customerId().nullable().default(null).describe("Only this customer's subscriptions."),
	status: z
		.enum(["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused", "all"])
		.nullable()
		.default(null)
		.describe("Leave out for every subscription that is not canceled."),
	limit: limit(),
	cursor: pageCursor(),
});

export const LIST_SUBSCRIPTIONS = defineOperation<z.output<typeof ListSubscriptions>>({
	name: "list_subscriptions",
	title: "List subscriptions",
	description: `List subscriptions, newest first, with their status, prices and when the current period ends. ${PAGE_NOTE}`,
	input: ListSubscriptions,
	needs: [[CUSTOMER, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		return {
			requirements: scopeOf(binding, data.customer),
			async execute(): Promise<ProviderOutput> {
				const page = await client.subscriptions({ customer: data.customer, status: data.status, limit: data.limit, cursor: cursor(data.cursor) });
				return billedOutput(binding, page, subscriptionData);
			},
		};
	},
});
