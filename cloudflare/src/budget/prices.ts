// What the engine charges (docs/plans/chunk-14b-design.md, The price table), in integer micro-dollars (µ$): the route's
// token rates, which the deploy reads from models.dev and the build gets as MINERVA_MODEL_PRICES (config.ts), and container
// and script time, which no catalog lists, from Cloudflare's pricing pages. List prices, without included allowances.
//
// Each charge is rounded up once, when it is made, and never again; totals are sums of charges. A call is charged at the
// rates its record kept when it was admitted, a script and a run's container time at the table the build has when they
// settle; each names the table's version.

import type { PriceTable, RoutePrices } from "@minerva/contract/internal";
import { type SettingsEnv, settings } from "../config.ts";
import { hashInput } from "../lib/canonical.ts";
import { sha256Hex } from "../lib/hash.ts";
import type { Tokens } from "../model/tap.ts";

/** A route's token rates, in µ$ per million tokens; `above` for a call whose input passes `above.inputTokens`. */
export type TokenRates = Omit<RoutePrices, "provider" | "model">;

/** The build's price table and its version: 16 hex of SHA-256 over its canonical JSON. */
export interface Prices {
	version: string;
	table: PriceTable;
}

/** What a call record keeps when it is admitted: its route's rates, and the version of the table they came from. */
export interface CallPrice {
	version: string;
	rates: TokenRates;
}

/**
 * A `standard-1` container an hour: ½ vCPU at $0.000020 per vCPU-second (billed on active use, so this is its ceiling),
 * 4 GiB at $0.0000025 per GiB-second and 8 GB of disk at $0.00000007 per GB-second (Cloudflare's Containers pricing).
 */
export const CONTAINER_PRICES: PriceTable["container"] = { instance: "standard-1", perHour: 74_016 };

/**
 * A script: $0.002 for its Dynamic Worker (each `load` is a unique Worker of the day), and $0.02 per million CPU-ms an hour
 * of wall time, which bounds its CPU time (Cloudflare's Dynamic Workers pricing).
 */
export const SCRIPT_PRICES: PriceTable["script"] = { perScript: 2_000, perHour: 72_000 };

/** The table with the route's prices from the build (none when it has none), and time at Cloudflare's prices. */
export function priceTable(route: RoutePrices | null): PriceTable {
	return { routes: route ? [route] : [], container: CONTAINER_PRICES, script: SCRIPT_PRICES };
}

/** Where the build's table comes from; replaced only by the test build, which adds the fake model's (src/faults/). */
export const PRICE_SOURCE: { table: (route: RoutePrices | null) => PriceTable } = { table: priceTable };

export async function pricesVersion(table: PriceTable): Promise<string> {
	return (await sha256Hex(hashInput("prices", table))).slice(0, 16);
}

const built = new WeakMap<SettingsEnv, { source: typeof PRICE_SOURCE.table; prices: Promise<Prices> }>();

/** The build's prices, made once per environment (again only if the source changed). */
export function pricesOf(env: SettingsEnv): Promise<Prices> {
	const source = PRICE_SOURCE.table;
	let entry = built.get(env);
	if (entry === undefined || entry.source !== source) {
		const table = source(settings(env).model.prices);
		entry = { source, prices: pricesVersion(table).then((version) => ({ version, table })) };
		built.set(env, entry);
	}
	return entry.prices;
}

/** The rates a call on (provider, model) is admitted at, or null when the table has no price for that route. */
export function callPrice(prices: Prices, provider: string, model: string): CallPrice | null {
	const route = prices.table.routes.find((entry) => entry.provider === provider && entry.model === model);
	if (!route) return null;
	const { provider: _provider, model: _model, ...rates } = route;
	return { version: prices.version, rates };
}

/** ⌈n / d⌉ for whole numbers below 2^53, exactly. */
function ceilDiv(n: number, d: number): number {
	if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`A charge's amount must be a whole number of µ$ below 2^53, not ${n}.`);
	const rest = n % d;
	return (n - rest) / d + (rest > 0 ? 1 : 0);
}

const PER_MILLION = 1_000_000;
const MS_PER_HOUR = 3_600_000;

/**
 * A call's charge: its uncached input (the reported input less cache reads and writes), cache reads, cache writes and output
 * (reasoning inside it) at its rates, those `above` when its input passes their threshold, rounded up once.
 */
export function callCharge(rates: TokenRates, tokens: Tokens): number {
	const tier = rates.above && tokens.input > rates.above.inputTokens ? rates.above : rates;
	const uncached = Math.max(0, tokens.input - tokens.cached - tokens.cacheWrite);
	return ceilDiv(uncached * tier.input + tokens.cached * tier.cachedInput + tokens.cacheWrite * tier.cacheWrite + tokens.output * tier.output, PER_MILLION);
}

/** A script's charge: `perScript`, and its wall time at `perHour`, rounded up once. */
export function scriptCharge(script: PriceTable["script"], ms: number): number {
	return ceilDiv(script.perScript * MS_PER_HOUR + ms * script.perHour, MS_PER_HOUR);
}

/** A run's container time at the container's `perHour`, rounded up once. */
export function containerTimeCharge(container: PriceTable["container"], ms: number): number {
	return ceilDiv(ms * container.perHour, MS_PER_HOUR);
}
