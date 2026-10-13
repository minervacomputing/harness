// What Stripe's operations share: the kinds, ids, and where an object sits.
//
// Customers are one hierarchical kind. A customer's charges, invoices and subscriptions are resources of the
// same kind inside it, keyed by their own id, so a grant on a customer covers what is billed to it. An object
// billed to no customer (a guest payment) sits nowhere, and only allowing every customer covers it. Stripe
// never moves an object to another customer, but writes still check the customer again just before sending.

import { z } from "zod";
import type { Binding } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError } from "../../gateway/connector.ts";
import { CHARGE_ID, CUSTOMER_ID, OBJECT_ID } from "./client.ts";
import * as money from "./money.ts";

export const CUSTOMER = "customer";
export const AMOUNT = money.AMOUNT;

export const CUSTOMER_ID_NOTE = "A customer id from list_customers, such as cus_123.";

/** scope.py `CustomerId`. */
export function customerId(): z.ZodString {
	return z.string().trim().min(5).max(110)
		.refine((value) => CUSTOMER_ID.test(value), "must be a customer id such as cus_123")
		.describe(CUSTOMER_ID_NOTE);
}

/** scope.py `PaymentId`. */
export function paymentId(): z.ZodString {
	return z.string().trim().min(4).max(110)
		.refine((value) => CHARGE_ID.test(value), "must be a payment id from list_payments, such as ch_123")
		.describe("A payment id from list_payments, such as ch_123.");
}

/** scope.py `Currency` (with the description each operation gives it): lowercased, as money.py's `currency` does. */
export function currencyCode(description: string) {
	return z.string().trim().min(3).max(3)
		.transform((value, ctx) => {
			try {
				return money.currency(value);
			} catch (error) {
				if (!(error instanceof money.MoneyError)) throw error;
				ctx.issues.push({ code: "custom", message: error.message, input: value });
				return z.NEVER;
			}
		})
		.describe(description);
}

/** scope.py `Amount` (with the description each operation gives it). */
export function amountText(description: string): z.ZodString {
	return z.string().trim().min(1).max(16).describe(description);
}

/** The run's own page token; the executor swaps it for Stripe's before the call is prepared. */
export function pageCursor() {
	return z.string().trim().max(200).nullable().default(null);
}

export function customer(binding: Binding, id: string): Resource {
	return binding.resource(CUSTOMER, id);
}

/** An object inside the customer it is billed to; an object of no customer sits nowhere. */
export function billed(binding: Binding, objectId: string, customerId: string | null): Resource {
	if (!OBJECT_ID.test(objectId) || (customerId !== null && !CUSTOMER_ID.test(customerId))) {
		throw new OperationError("PROVIDER_FAILED", "Stripe returned an unexpected response.");
	}
	return binding.resource(CUSTOMER, objectId, customerId ? [customerId] : []);
}

export function amount(binding: Binding, currency: string, minor: number): Resource {
	return binding.resource(AMOUNT, money.amountId(currency, minor), money.ancestors(currency, minor));
}

/** The upstream cursor a call goes on from: a Stripe object id, else INVALID_CURSOR. */
export function cursor(value: string | null): string | null {
	if (value !== null && !OBJECT_ID.test(value)) throw new OperationError("INVALID_CURSOR", "This cursor is not valid.");
	return value;
}
