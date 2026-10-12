// Stripe's write operations: refunding a payment and crediting a customer's balance, ported from
// backend/connectors/stripe/writes.py.
//
// Each needs its action on the customer (and Read on it) and on the amount. The amount is authorized in the
// currency the agent names, before Minerva has said anything about the payment or customer; the currency is
// checked against Stripe's just before sending, and a mismatch is refused. A refund is checked against what
// is left to refund at that moment, so an agent cannot ask Stripe for more than the payment has.

import { z } from "zod";
import type { Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import type { Json } from "../../lib/json.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, isSingleLine } from "../../lib/text.ts";
import type { Charge, Customer, StripeClient } from "./client.ts";
import * as money from "./money.ts";
import { AMOUNT, CUSTOMER, amount, amountText, billed, currencyCode, customer, customerId, paymentId } from "./scope.ts";

/**
 * writes.py `Money._exact`, a model validator: the amount must be one Stripe takes exactly in the currency.
 * Pydantic runs it only once every field passed; validation.ts drops it otherwise, so it only has to skip
 * what it cannot read.
 */
function exact(value: { amount?: unknown; currency?: unknown }, ctx: z.RefinementCtx): void {
	if (typeof value.amount !== "string" || typeof value.currency !== "string") return;
	try {
		money.parse(value.amount, value.currency);
	} catch (error) {
		if (!(error instanceof money.MoneyError)) throw error;
		ctx.addIssue({ code: "custom", message: `amount ${error.message}` });
	}
}

async function fetchCharge(client: StripeClient, payment: string): Promise<Charge> {
	try {
		return await client.charge(payment);
	} catch (error) {
		if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
		throw error;
	}
}

function refusal(message: string): OperationError {
	return new OperationError("REFUND_REFUSED", message);
}

function checkRefund(charge: Charge, currency: string, minor: number): void {
	if (charge.currency.toLowerCase() !== currency) throw money.mismatch(charge.currency.toLowerCase());
	if (charge.status !== "succeeded" || !charge.captured) throw refusal("Only a successful, captured payment can be refunded.");
	if (charge.disputed) throw refusal("This payment is disputed; Stripe does not refund disputed payments.");
	// As BigInt, so the difference of two integers Stripe sent is exact whatever their size.
	const left = BigInt(charge.amount_captured) - BigInt(charge.amount_refunded);
	if (left <= 0n) throw refusal("This payment is already refunded in full.");
	if (BigInt(minor) > left) throw refusal(`Only ${money.display(left, currency)} of this payment is left to refund.`);
}

// The fields of writes.py's `Money` come first, as Pydantic orders a subclass's fields.
const RefundPayment = z
	.strictObject({
		amount: amountText(
			"How much to refund, in the currency's usual unit, as a decimal string: 12.50 for 12.50 USD. At most what is left to refund.",
		),
		currency: currencyCode("The payment's currency, such as usd."),
		payment: paymentId(),
		reason: z.enum(["duplicate", "requested_by_customer"]).nullable().default(null),
	})
	.superRefine(exact)
	.meta({ title: "RefundPayment" });

export const REFUND_PAYMENT = defineOperation<z.output<typeof RefundPayment>>({
	name: "refund_payment",
	title: "Refund a payment",
	description:
		"Refund part or all of a payment to the card or account it came from. Give the amount and the payment's currency; the refund goes through at once, and Stripe reports when it reaches the customer. Disputed payments cannot be refunded.",
	input: RefundPayment,
	needs: [
		[CUSTOMER, "read"],
		[CUSTOMER, "refund"],
		[AMOUNT, "refund"],
	],
	outputAction: "refund",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		const charge = await fetchCharge(client, data.payment);
		const resource = billed(binding, charge.id, charge.customer);
		const minor = money.parse(data.amount, data.currency);
		return {
			requirements: [
				{ need: resource, action: "read" },
				{ need: resource, action: "refund" },
				{ need: amount(binding, data.currency, minor), action: "refund" },
			],
			async execute(): Promise<ProviderOutput> {
				const current = await fetchCharge(client, data.payment);
				if (current.customer !== charge.customer) throw new OperationError("PAYMENT_CHANGED", "This payment changed since it was checked. Try again.");
				checkRefund(current, data.currency, minor);
				const refund = await client.refund({ charge: current.id, amount: minor, reason: data.reason });
				const record: { [key: string]: Json } = {
					id: refund.id,
					payment: refund.charge,
					amount: money.major(refund.amount, refund.currency.toLowerCase()),
					currency: refund.currency,
					status: refund.status,
					reason: refund.reason,
					created: refund.created,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const CreditCustomer = z
	.strictObject({
		amount: amountText("How much to credit, in the currency's usual unit, as a decimal string: 12.50."),
		currency: currencyCode("The customer's currency, such as usd. A customer has one currency once billed."),
		customer: customerId(),
		description: strippedStr({ min: 1, max: 350 }).refine(isSingleLine, SINGLE_LINE).describe("Why the credit is given; the customer may see it."),
	})
	.superRefine(exact)
	.meta({ title: "CreditCustomer" });

export const CREDIT_CUSTOMER = defineOperation<z.output<typeof CreditCustomer>>({
	name: "credit_customer",
	title: "Credit a customer",
	description:
		"Add credit to a customer's balance, which Stripe takes off their next invoices. Nothing is paid out, and the customer is not notified. Give the amount in the customer's currency and a description of why.",
	input: CreditCustomer,
	needs: [
		[CUSTOMER, "read"],
		[CUSTOMER, "credit"],
		[AMOUNT, "credit"],
	],
	outputAction: "credit",
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const client = binding.client as StripeClient;
		const resource = customer(binding, data.customer);
		const minor = money.parse(data.amount, data.currency);
		return {
			requirements: [
				{ need: resource, action: "read" },
				{ need: resource, action: "credit" },
				{ need: amount(binding, data.currency, minor), action: "credit" },
			],
			async execute(): Promise<ProviderOutput> {
				let found: Customer;
				try {
					found = await client.customer(data.customer);
				} catch (error) {
					if (error instanceof OperationError && error.code === "NOT_FOUND") throw denied();
					throw error;
				}
				if (found.deleted) throw denied();
				if (found.currency !== null && found.currency.toLowerCase() !== data.currency) throw money.mismatch(found.currency.toLowerCase());
				const entry = await client.credit({ customer: found.id, amount: minor, currency: data.currency, description: data.description });
				const currency = entry.currency.toLowerCase();
				const record: { [key: string]: Json } = {
					id: entry.id,
					customer: entry.customer,
					credit: entry.amount < 0 ? money.major(-entry.amount, currency) : null,
					currency,
					// Negative is credit the customer has; it is applied to their next invoices.
					ending_balance: entry.ending_balance !== null ? money.major(entry.ending_balance, currency) : null,
					description: entry.description,
					created: entry.created,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
