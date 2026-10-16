// The price table and its charges (src/budget/prices.ts; docs/plans/chunk-14b-design.md, The price table): each charge
// rounded up once, a call at its tier's rates, the table's version, and the build's table.

import type { RoutePrices } from "@minerva/contract/internal";
import { afterEach, expect, test } from "vitest";
import { CONTAINER_PRICES, PRICE_SOURCE, SCRIPT_PRICES, callCharge, callPrice, containerTimeCharge, priceTable, pricesOf, pricesVersion, scriptCharge } from "../../src/budget/prices.ts";
import { reservation } from "../../src/model/policy.ts";
import { settingsEnv } from "./settings.ts";

/** Production's route on 2026-10-16, as the deploy reads it (scripts/model-prices.ts). */
const GLM: RoutePrices = { provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", input: 150_000, cachedInput: 30_000, cacheWrite: 150_000, output: 500_000 };
/** Staging's, with its context tier. */
const SOL: RoutePrices = {
	provider: "openai",
	model: "gpt-6.1-sol",
	input: 2_000_000,
	cachedInput: 100_000,
	cacheWrite: 2_500_000,
	output: 10_000_000,
	above: { inputTokens: 272_000, input: 4_000_000, cachedInput: 200_000, cacheWrite: 5_000_000, output: 15_000_000 },
};

const tokens = (input: number, output: number, cached = 0, cacheWrite = 0) => ({ input, output, cached, cacheWrite, reasoning: 0 });
const rates = ({ provider: _provider, model: _model, ...rest }: RoutePrices) => rest;

afterEach(() => {
	PRICE_SOURCE.table = priceTable;
});

test("a call is charged its uncached input, cache reads and writes, and output at its rates, rounded up once", () => {
	// 800 uncached at $0.15, 200 cached at $0.03, 500 out at $0.50 per million: 120 + 6 + 250 µ$.
	expect(callCharge(rates(GLM), tokens(1000, 500, 200))).toBe(376);
	// Rounded once: 19 uncached and 1 cached token are 2.88 µ$, charged 3, where rounding each would charge 4.
	expect(callCharge(rates(GLM), tokens(20, 0, 1))).toBe(3);
	// Reasoning is inside output; a cache write without a rate of its own is charged at input.
	expect(callCharge(rates(GLM), { ...tokens(10, 4, 0, 10), reasoning: 4 })).toBe(Math.ceil((10 * 150_000 + 4 * 500_000) / 1e6));
	// A refused call reports nothing, and is charged nothing.
	expect(callCharge(rates(GLM), tokens(0, 0))).toBe(0);
	// An unmetered call is charged its reservation: production's window and cap, 23,296 µ$.
	const reserved = reservation(8192);
	expect(callCharge(rates(GLM), tokens(reserved.input, reserved.output))).toBe(23_296);
});

test("a call whose input passes its tier's threshold is charged the tier's rates, all of them", () => {
	// 100,000 uncached at $2, 72,000 cached at $0.10, 100,000 written at $2.50 and 1,000 out at $10 per million.
	expect(callCharge(rates(SOL), tokens(272_000, 1000, 72_000, 100_000))).toBe(200_000 + 7_200 + 250_000 + 10_000);
	// One more uncached token passes the threshold: $4, $0.20, $5 and $15.
	expect(callCharge(rates(SOL), tokens(272_001, 1000, 72_000, 100_000))).toBe(400_004 + 14_400 + 500_000 + 15_000);
});

test("a script is charged per script and for its time, rounded up once: two 1 ms scripts are 2 × 2,001 µ$", () => {
	expect(scriptCharge(SCRIPT_PRICES, 1)).toBe(2_001);
	expect(scriptCharge(SCRIPT_PRICES, 1) + scriptCharge(SCRIPT_PRICES, 1)).toBe(4_002);
	expect(scriptCharge(SCRIPT_PRICES, 0)).toBe(2_000);
	// Its 120 s clock: 2,000 µ$ and 2,400 µ$ of time.
	expect(scriptCharge(SCRIPT_PRICES, 120_000)).toBe(4_400);
	expect(scriptCharge(SCRIPT_PRICES, 3_600_000)).toBe(74_000);
});

test("container time is charged at its hourly price, rounded up once", () => {
	expect(containerTimeCharge(CONTAINER_PRICES, 3_600_000)).toBe(74_016);
	expect(containerTimeCharge(CONTAINER_PRICES, 1)).toBe(1);
	expect(containerTimeCharge(CONTAINER_PRICES, 0)).toBe(0);
	expect(containerTimeCharge(CONTAINER_PRICES, 70 * 60_000)).toBe(86_352);
});

test("the table's version is 16 hex of its canonical JSON, whatever its keys' order, and changes with any price", async () => {
	const version = await pricesVersion(priceTable(GLM));
	expect(version).toMatch(/^[0-9a-f]{16}$/);
	const reordered = { script: SCRIPT_PRICES, container: CONTAINER_PRICES, routes: [Object.fromEntries(Object.entries(GLM).reverse()) as RoutePrices] };
	expect(await pricesVersion(reordered)).toBe(version);
	expect(await pricesVersion(priceTable({ ...GLM, output: 500_001 }))).not.toBe(version);
	expect(await pricesVersion(priceTable(null))).not.toBe(version);
});

test("the build's table has its route's prices from its settings; a call on another route has none", async () => {
	const env = settingsEnv({ MINERVA_MODEL_PRICES: JSON.stringify(GLM) });
	const prices = await pricesOf(env);
	expect(prices.table).toEqual({ routes: [GLM], container: { instance: "standard-1", perHour: 74_016 }, script: { perScript: 2_000, perHour: 72_000 } });
	expect(prices.version).toBe(await pricesVersion(prices.table));
	expect(await pricesOf(env)).toBe(prices);
	expect(callPrice(prices, "workers-ai", GLM.model)).toEqual({ version: prices.version, rates: rates(GLM) });
	expect(callPrice(prices, "openai", GLM.model)).toBeNull();
	expect((await pricesOf(settingsEnv())).table.routes).toEqual([]);
	// The test build's source (src/faults/prices.ts) replaces the table.
	PRICE_SOURCE.table = (route) => ({ ...priceTable(route), routes: [] });
	expect((await pricesOf(env)).table.routes).toEqual([]);
});
