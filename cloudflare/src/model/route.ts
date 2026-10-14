// Where model requests go, from the MINERVA_MODEL_* settings (ARCHITECTURE.md: The harness, Model). Read at
// each call, so a deploy that changes them applies to the next request.
//
// Every upstream but the fake goes through the Worker's own AI Gateway (`MINERVA_MODEL_GATEWAY`, named for the
// instance by the build, prompt logging off), never createAI's default gateway, which logs prompts: Workers AI
// models through `env.AI.run`, OpenAI and Anthropic models through the gateway's universal endpoint over the
// same binding, with the provider key the gateway holds (no key lives in the Worker).

import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAI, type WorkersAIModelId } from "agents/models/pi-ai";
import type { Settings } from "../config.ts";

/** The context window the loop assumes; compaction runs only when it is nearly full. */
export const CONTEXT_WINDOW = 128_000;
/**
 * How long a model call's answer may be quiet, before it starts and between its chunks. The wrapper times the start (model/provider.ts), createAI each chunk.
 */
export const QUIET_MS = 120_000;

export interface ModelRoute {
	provider: Settings["model"]["provider"];
	/** Forced as the request's model. */
	name: string;
	gateway: string;
	api: Settings["model"]["api"];
	/** The output cap (MINERVA_MODEL_MAX_OUTPUT_TOKENS, 8192 by default). */
	cap: number;
	/** Empty for none. */
	reasoningEffort: string;
	reasoningSummary: string;
}

export function routeOf(settings: Settings): ModelRoute {
	const model = settings.model;
	return {
		provider: model.provider,
		name: model.name,
		gateway: model.gateway,
		api: model.api,
		cap: model.maxOutputTokens,
		reasoningEffort: model.reasoningEffort,
		reasoningSummary: model.reasoningSummary,
	};
}

/** A model behind a provider, and the stream options the route adds to every request. */
export interface Upstream {
	provider: Pick<Provider, "streamSimple">;
	model: Model<Api>;
	options: Partial<SimpleStreamOptions> & { [key: string]: unknown };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const WORKERS_AI_EFFORTS = new Set(["low", "medium", "high"]);
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * The upstream a route names. The fake model is not here: only the test build and the tests have it
 * (model/fake.ts `fakeUpstream`), so production cannot run it whatever its settings say.
 */
export function upstreamOf(route: ModelRoute, binding: Ai | undefined): Upstream {
	if (route.provider === "fake") throw new Error("The fake model runs only in the test build.");
	if (!binding) throw new Error("The AI binding is missing.");
	if (route.gateway === "default") throw new Error("Model requests must not go through the account's default AI Gateway, which logs prompts.");
	const ai = createAI({ binding, id: route.gateway, collectLog: false });
	const effort = route.reasoningEffort;
	if (route.provider === "workers-ai") {
		const model = ai(route.name as WorkersAIModelId, {
			contextWindow: CONTEXT_WINDOW,
			maxTokens: route.cap,
			streamIdleTimeoutMs: QUIET_MS,
			...(WORKERS_AI_EFFORTS.has(effort) ? { reasoningEffort: effort as "low" | "medium" | "high" } : {}),
		});
		return { provider: ai.provider, model, options: {} };
	}
	const reasoning = THINKING_LEVELS.has(effort);
	const quiet = { streamIdleTimeoutMs: QUIET_MS };
	const common = {
		id: route.name,
		name: route.name,
		input: ["text" as const],
		cost: ZERO_COST,
		reasoning,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: route.cap,
	};
	const options: Upstream["options"] = reasoning ? { reasoning: effort as SimpleStreamOptions["reasoning"] } : {};
	if (route.provider === "anthropic") {
		const model: Model<Api> = { ...common, api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
		return { provider: ai.provider, model: ai(model, quiet), options };
	}
	if (route.api === "chat") {
		const model: Model<"openai-completions"> = {
			...common,
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			compat: { supportsStore: true, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: "max_completion_tokens" },
		};
		return { provider: ai.provider, model: ai(model, quiet), options };
	}
	const model: Model<"openai-responses"> = {
		...common,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		compat: { supportsStrictMode: false },
	};
	const summary = reasoning && route.reasoningSummary ? { reasoningSummary: route.reasoningSummary } : {};
	return { provider: ai.provider, model: ai(model, quiet), options: { ...options, ...summary } };
}
