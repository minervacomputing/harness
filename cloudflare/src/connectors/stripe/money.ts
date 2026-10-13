// Amounts as Stripe carries them, and the amount kind that caps refunds and credits.
//
// Stripe gives amounts in a currency's smallest unit: cents for USD, yen for JPY (a zero-decimal currency),
// and thousandths for the three-decimal currencies, whose amounts Stripe wants divisible by ten. ISK and UGX
// have no fractions, but Stripe still carries them in hundredths that are always 00 (5 UGX is 500). Agents
// give amounts in major units, as a decimal string ("12.50"), and Minerva converts them exactly: the digits
// are shifted as text and counted as BigInt, never as a float.
//
// Users cap amounts with the hierarchical `amount` kind. An amount, `usd=1250`, is never granted itself. It
// sits inside every tier that covers it and inside its currency:
//
// - `usd<=50`, "Up to 50 USD", for every tier at or above the amount, smallest first;
// - `usd>20`, "More than 20 USD", for every tier below the amount, largest first;
// - `usd`, any amount in USD.
//
// So allowing `usd<=50` allows amounts up to 50 USD, and a workspace ceiling that denies `usd>100` blocks
// anything larger, whatever the users below it allow. Tiers come from one fixed ladder per currency (scaled
// up for zero-decimal currencies, whose units are small), since an amount's ancestors must name every tier a
// grant could use.

import { OperationError } from "../../gateway/connector.ts";

export const AMOUNT = "amount";
/** Stripe's zero-decimal currencies (https://docs.stripe.com/currencies#zero-decimal). */
export const ZERO_DECIMAL: ReadonlySet<string> = new Set([
	"bif",
	"clp",
	"djf",
	"gnf",
	"jpy",
	"kmf",
	"krw",
	"mga",
	"pyg",
	"rwf",
	"vnd",
	"vuv",
	"xaf",
	"xof",
	"xpf",
]);
/** Whole-unit currencies Stripe carries as two-decimal (https://docs.stripe.com/currencies#special-cases). */
export const WHOLE_UNIT: ReadonlySet<string> = new Set(["isk", "ugx"]);
/** Three-decimal currencies; Stripe takes their amounts only in multiples of ten. */
export const THREE_DECIMAL: ReadonlySet<string> = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
export const LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
/** Stripe's largest amount: eight digits in the smallest unit. */
export const MAX_MINOR = 99_999_999;
export const CURRENCY = /^[a-z]{3}$/;
const TIER = /^([a-z]{3})(<=|>)([1-9][0-9]{0,8})$/;
const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,3})?$/;

/** The reason an amount or currency is refused, worded for the model. */
export class MoneyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MoneyError";
	}
}

export function exponent(currency: string): number {
	if (ZERO_DECIMAL.has(currency)) return 0;
	if (THREE_DECIMAL.has(currency)) return 3;
	return 2;
}

/** The currency's tiers in major units. */
export function tiers(currency: string): number[] {
	const scale = ZERO_DECIMAL.has(currency) || WHOLE_UNIT.has(currency) ? 100 : 1;
	return LADDER.map((step) => step * scale);
}

/** A whole number of major units in the smallest unit (at most 1,000,000 × 1000, well inside an integer). */
function minorOf(major: number, currency: string): number {
	return major * 10 ** exponent(currency);
}

/** A decimal amount in major units, in the smallest unit; refused unless Stripe can take it exactly. */
export function parse(value: string, currency: string): number {
	if (!DECIMAL.test(value)) throw new MoneyError("must be a positive decimal amount such as 12.50");
	const places = exponent(currency);
	const [whole, fraction = ""] = value.split(".") as [string, string?];
	// The amount is a whole number of the smallest unit exactly when the digits past `places` are all zeros.
	if (/[^0]/.test(fraction.slice(places))) throw new MoneyError(`has more decimals than ${currency.toUpperCase()} has`);
	const minor = BigInt(whole + fraction.slice(0, places).padEnd(places, "0"));
	if (WHOLE_UNIT.has(currency) && minor % 100n !== 0n) throw new MoneyError(`must be a whole number of ${currency.toUpperCase()}`);
	if (THREE_DECIMAL.has(currency) && minor % 10n !== 0n) throw new MoneyError(`must be a multiple of 0.01 ${currency.toUpperCase()}`);
	if (!(minor > 0n && minor <= BigInt(MAX_MINOR))) throw new MoneyError("must be more than zero and at most Stripe's largest amount");
	return Number(minor);
}

/**
 * An amount in the smallest unit as a decimal string in major units, sign included: 1250 cents is "12.50".
 * `minor` must be an integer; a difference of two amounts comes as BigInt, so it stays exact past 2^53.
 */
export function major(minor: number | bigint, currency: string): string {
	const value = BigInt(minor);
	const places = exponent(currency);
	const shown = WHOLE_UNIT.has(currency) && value % 100n === 0n ? 0 : places;
	const digits = (value < 0n ? -value : value).toString().padStart(places + 1, "0");
	const whole = digits.slice(0, digits.length - places);
	// Only whole-unit amounts drop decimals, and only when those are zeros, so nothing is ever rounded.
	const fraction = digits.slice(digits.length - places, digits.length - places + shown);
	return `${value < 0n ? "-" : ""}${whole}${shown > 0 ? `.${fraction}` : ""}`;
}

export function display(minor: number | bigint, currency: string): string {
	return `${major(minor, currency)} ${currency.toUpperCase()}`;
}

export function amountId(currency: string, minor: number): string {
	return `${currency}=${minor}`;
}

export function ancestors(currency: string, minor: number): string[] {
	const steps = tiers(currency);
	const upTo = steps.filter((step) => minorOf(step, currency) >= minor).map((step) => `${currency}<=${step}`);
	const above = [...steps]
		.reverse()
		.filter((step) => minorOf(step, currency) < minor)
		.map((step) => `${currency}>${step}`);
	return [...upTo, ...above, currency];
}

/** The name of a tier or currency users can choose; null for anything else (an amount itself). */
export function name(resourceId: string): string | null {
	if (CURRENCY.test(resourceId)) return `Any amount in ${resourceId.toUpperCase()}`;
	const match = TIER.exec(resourceId);
	if (match === null) return null;
	const [, currency, relation, digits] = match as unknown as [string, string, string, string];
	const value = Number(digits);
	if (!tiers(currency).includes(value)) return null;
	const shown = display(minorOf(value, currency), currency);
	return relation === "<=" ? `Up to ${shown}` : `More than ${shown}`;
}

/** What users choose from for one currency: the currency, then each tier. */
export function choices(currency: string): string[] {
	const steps = tiers(currency);
	return [currency, ...steps.map((step) => `${currency}<=${step}`), ...steps.map((step) => `${currency}>${step}`)];
}

/** A three-letter currency code, lowercased; MoneyError otherwise. */
export function currency(value: string): string {
	const lowered = value.toLowerCase();
	if (!CURRENCY.test(lowered)) throw new MoneyError("must be a three-letter currency code such as usd");
	return lowered;
}

export function mismatch(expected: string): OperationError {
	return new OperationError("CURRENCY_MISMATCH", `This is in ${expected.toUpperCase()}. Give the amount and currency in ${expected.toUpperCase()}.`);
}
