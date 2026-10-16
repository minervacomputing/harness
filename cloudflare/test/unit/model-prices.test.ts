// The deploy's read of models.dev (scripts/model-prices.ts), against an excerpt of its api.json saved on 2026-10-16
// (test/fixtures/models-dev-api.json): production's Workers AI model, staging's OpenAI model with a context tier, and an
// Anthropic model. No test reaches the network: the reads are of the excerpt, or of a fetch stubbed here.

import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { MODELS_DEV_URL, buildPrices, describePrices, routePricesFrom } from "../../scripts/model-prices.ts";

const API = JSON.parse(readFileSync(new URL("../fixtures/models-dev-api.json", import.meta.url), "utf8")) as { [provider: string]: { models: { [model: string]: { cost?: { [key: string]: unknown } } } } };

/** The excerpt with one model's `cost` changed. */
function withCost(provider: string, model: string, cost: { [key: string]: unknown } | undefined): unknown {
	const api = structuredClone(API);
	(api[provider]?.models[model] as { cost?: unknown }).cost = cost;
	return api;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("a route's prices are its cost in µ$ per million tokens, rounded; a missing cache rate is the input rate", () => {
	// Workers AI's model has no cache-write rate (models.dev's `cloudflare-workers-ai`); 0.15 × 1e6 is 149999.99999999997.
	expect(routePricesFrom(API, "workers-ai", "@cf/zai-org/glm-5.3-flash")).toEqual({
		provider: "workers-ai",
		model: "@cf/zai-org/glm-5.3-flash",
		input: 150_000,
		cachedInput: 30_000,
		cacheWrite: 150_000,
		output: 500_000,
	});
	expect(routePricesFrom(API, "anthropic", "claude-sonnet-5-5")).toEqual({
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		input: 2_000_000,
		cachedInput: 100_000,
		cacheWrite: 2_500_000,
		output: 10_000_000,
	});
});

test("a context tier is the rates above its size", () => {
	expect(routePricesFrom(API, "openai", "gpt-6.1-sol")).toEqual({
		provider: "openai",
		model: "gpt-6.1-sol",
		input: 2_000_000,
		cachedInput: 100_000,
		cacheWrite: 2_500_000,
		output: 10_000_000,
		above: { inputTokens: 272_000, input: 4_000_000, cachedInput: 200_000, cacheWrite: 5_000_000, output: 15_000_000 },
	});
	// A tier without cache rates charges them at its own input rate.
	const tier = { input: 4, output: 15, tier: { type: "context", size: 272_000 } };
	expect(routePricesFrom(withCost("openai", "gpt-6.1-sol", { input: 2, output: 10, tiers: [tier] }), "openai", "gpt-6.1-sol").above).toEqual({
		inputTokens: 272_000,
		input: 4_000_000,
		cachedInput: 4_000_000,
		cacheWrite: 4_000_000,
		output: 15_000_000,
	});
});

test("a model without a cost, or with prices the table cannot hold, is refused", () => {
	expect(() => routePricesFrom(API, "openai", "gpt-unknown")).toThrow("models.dev has no model gpt-unknown under openai.");
	expect(() => routePricesFrom(API, "workers-ai", "gpt-6.1-sol")).toThrow("models.dev has no model gpt-6.1-sol under cloudflare-workers-ai.");
	expect(() => routePricesFrom(API, "openai", "gpt-image-1")).toThrow("models.dev has no cost for openai/gpt-image-1.");
	expect(() => routePricesFrom(withCost("openai", "gpt-6.1-sol", { input: 2 }), "openai", "gpt-6.1-sol")).toThrow("models.dev gives openai/gpt-6.1-sol's output as undefined, not dollars per million tokens.");
	expect(() => routePricesFrom(withCost("openai", "gpt-6.1-sol", { input: -1, output: 1 }), "openai", "gpt-6.1-sol")).toThrow("openai/gpt-6.1-sol's input as -1");
	const tier = (size: number) => ({ input: 4, output: 15, tier: { type: "context", size } });
	expect(() => routePricesFrom(withCost("openai", "gpt-6.1-sol", { input: 2, output: 10, tiers: [tier(32_000), tier(128_000)] }), "openai", "gpt-6.1-sol")).toThrow("tiers other than one context tier");
	expect(() => routePricesFrom(withCost("openai", "gpt-6.1-sol", { input: 2, output: 10, tiers: [{ input: 1, output: 1, tier: { type: "batch" } }] }), "openai", "gpt-6.1-sol")).toThrow(
		"a tier other than a context tier",
	);
	expect(() => routePricesFrom(null, "openai", "gpt-6.1-sol")).toThrow("models.dev has no model gpt-6.1-sol under openai.");
});

test("the deploy prints what it read, and gives the build its JSON; the fake model needs no read", async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify(API)));
	vi.stubGlobal("fetch", fetch);
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	expect(await buildPrices({ provider: "fake", model: "fake-1" })).toBe("");
	expect(fetch).not.toHaveBeenCalled();
	const prices = await buildPrices({ provider: "openai", model: "gpt-6.1-sol" });
	expect(fetch).toHaveBeenCalledWith(MODELS_DEV_URL, expect.anything());
	expect(JSON.parse(prices)).toEqual(routePricesFrom(API, "openai", "gpt-6.1-sol"));
	expect(log.mock.calls).toEqual([
		[
			"openai gpt-6.1-sol (models.dev): input $2.00, cached input $0.10, cache write $2.50, output $10.00 per million tokens; above 272000 input tokens: input $4.00, cached input $0.20, cache write $5.00, output $15.00 per million tokens",
		],
	]);
	expect(describePrices(routePricesFrom(API, "workers-ai", "@cf/zai-org/glm-5.3-flash"))).toBe(
		"workers-ai @cf/zai-org/glm-5.3-flash (models.dev): input $0.15, cached input $0.03, cache write $0.15, output $0.50 per million tokens",
	);
});

test("the deploy stops when models.dev cannot be read, or has no cost for the model", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
	await expect(buildPrices({ provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash" })).rejects.toThrow(`The model's prices could not be read from ${MODELS_DEV_URL} (HTTP 503): a deploy needs them.`);
	vi.stubGlobal("fetch", async () => {
		throw new TypeError("fetch failed");
	});
	await expect(buildPrices({ provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash" })).rejects.toThrow("(fetch failed): a deploy needs them.");
	vi.stubGlobal("fetch", async () => new Response(JSON.stringify(API)));
	await expect(buildPrices({ provider: "openai", model: "gpt-image-1" })).rejects.toThrow("models.dev has no cost for openai/gpt-image-1.");
	await expect(buildPrices({ provider: "mistral", model: "large" })).rejects.toThrow("models.dev has no provider for mistral.");
});
