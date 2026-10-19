// The model's prices, read from models.dev by the deploy and given to
// the build as MINERVA_MODEL_PRICES (cloudflare.config.ts), which src/config.ts parses: one source and one code path for
// every provider. models.dev is MIT-licensed. scripts/deploy.ts and scripts/reset.ts read them before they build; a deploy
// without them stops, and the fake model's are in the test build's code (src/faults/).

import type { RoutePrices } from "@minerva/contract/internal";
import { buildSettings } from "./build-settings.ts";
import { type Instance, instanceVars } from "./instance.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Each provider's id in models.dev. */
const MODELS_DEV_PROVIDERS = { "workers-ai": "cloudflare-workers-ai", openai: "openai", anthropic: "anthropic" } as const;

type Provider = keyof typeof MODELS_DEV_PROVIDERS;

type Entry = { [key: string]: unknown };

const isRecord = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);

/** Dollars per million tokens as whole µ$ per million: rounded, since 0.15 × 1e6 is not exactly 150000. */
function micros(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`models.dev gives ${what} as ${JSON.stringify(value)}, not dollars per million tokens.`);
	return Math.round(value * 1_000_000);
}

/** One set of rates; a missing cache rate is charged at the input rate. */
function rates(cost: Entry, what: string) {
	const input = micros(cost.input, `${what}'s input`);
	return {
		input,
		cachedInput: cost.cache_read === undefined ? input : micros(cost.cache_read, `${what}'s cache_read`),
		cacheWrite: cost.cache_write === undefined ? input : micros(cost.cache_write, `${what}'s cache_write`),
		output: micros(cost.output, `${what}'s output`),
	};
}

/**
 * The route's prices in models.dev's api.json: its `cost` in dollars per million tokens as µ$, and a `tiers` entry of type
 * `context` as `above` (the rates when a call's input passes `size` tokens). Throws when the model or its cost is missing,
 * or its tiers are not one context tier.
 */
export function routePricesFrom(api: unknown, provider: Provider, model: string): RoutePrices {
	const id = MODELS_DEV_PROVIDERS[provider];
	const providerEntry = isRecord(api) ? api[id] : undefined;
	const models = isRecord(providerEntry) ? providerEntry.models : undefined;
	const entry = isRecord(models) ? models[model] : undefined;
	if (!isRecord(entry)) throw new Error(`models.dev has no model ${model} under ${id}.`);
	const what = `${id}/${model}`;
	if (!isRecord(entry.cost)) throw new Error(`models.dev has no cost for ${what}.`);
	const cost = entry.cost;
	const prices: RoutePrices = { provider, model, ...rates(cost, what) };
	const tiers = cost.tiers === undefined ? [] : cost.tiers;
	if (!Array.isArray(tiers) || tiers.length > 1) throw new Error(`models.dev gives ${what} tiers other than one context tier, which the price table cannot hold.`);
	const [tier] = tiers as unknown[];
	if (tier !== undefined) {
		const kind = isRecord(tier) && isRecord(tier.tier) ? tier.tier : undefined;
		if (!isRecord(tier) || kind?.type !== "context" || !Number.isSafeInteger(kind.size) || (kind.size as number) < 1) {
			throw new Error(`models.dev gives ${what} a tier other than a context tier, which the price table cannot hold.`);
		}
		prices.above = { inputTokens: kind.size as number, ...rates(tier, `${what}'s tier above ${String(kind.size)} tokens`) };
	}
	return prices;
}

/** What the deploy prints of the prices it read, in dollars per million tokens. */
export function describePrices(prices: RoutePrices): string {
	const dollars = (value: number) => `$${(value / 1_000_000).toFixed(6).replace(/0{1,4}$/, "")}`;
	const line = (rates: Omit<RoutePrices, "provider" | "model" | "above">) =>
		`input ${dollars(rates.input)}, cached input ${dollars(rates.cachedInput)}, cache write ${dollars(rates.cacheWrite)}, output ${dollars(rates.output)} per million tokens`;
	const above = prices.above ? `; above ${prices.above.inputTokens} input tokens: ${line(prices.above)}` : "";
	return `${prices.provider} ${prices.model} (models.dev): ${line(prices)}${above}`;
}

/**
 * The build's MINERVA_MODEL_PRICES for a route: empty for the fake model, whose prices the test build has in code; else the
 * route's prices from models.dev as JSON, printed. Throws when models.dev cannot be read or has no cost for the model.
 */
export async function buildPrices(route: { provider: string; model: string }): Promise<string> {
	if (route.provider === "fake") return "";
	if (!Object.hasOwn(MODELS_DEV_PROVIDERS, route.provider)) throw new Error(`models.dev has no provider for ${route.provider}.`);
	let api: unknown;
	try {
		const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		api = await response.json();
	} catch (error) {
		throw new Error(`The model's prices could not be read from ${MODELS_DEV_URL} (${error instanceof Error ? error.message : String(error)}): a deploy needs them.`);
	}
	const prices = routePricesFrom(api, route.provider as Provider, route.model);
	console.log(describePrices(prices));
	return JSON.stringify(prices);
}

/** The instance's MINERVA_MODEL_PRICES (`buildPrices`), for the route its deployed build is configured with. */
export function instancePrices(instance: Instance): Promise<string> {
	const values = buildSettings({ deployed: true, faults: instance.test, offline: false }, instanceVars(instance), instance.names.gateway);
	return buildPrices({ provider: values.MINERVA_MODEL_PROVIDER.trim(), model: values.MINERVA_MODEL_NAME.trim() });
}
