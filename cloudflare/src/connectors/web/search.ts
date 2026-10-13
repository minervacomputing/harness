// Brave Search API: web results as titles, addresses and
// snippets, never page contents.
//
// The key is the operator's. A key Brave refuses means search is unavailable on this instance, not that the
// user's connection needs attention, so its errors never mark the connection for reconnecting.

import { z } from "zod";
import type { ProviderIo } from "../../contracts/connectors.ts";
import { OperationError } from "../../gateway/connector.ts";
import { ProviderHTTP } from "../../gateway/http.ts";
import { laxBool } from "../../lib/lax.ts";
import { htmlUnescape } from "../../lib/text.ts";

export const BASE_URL = "https://api.search.brave.com/res/v1/";
/** Brave pages by result page, from 0. */
export const MAX_PAGE = 9;

// The answer, unknown fields ignored: a missing string is "", a null one
// fails the whole answer.
const BraveResult = z.object({
	title: z.string().default(""),
	url: z.string(),
	description: z.string().default(""),
	age: z.string().nullable().default(null),
});
const Web = z.object({ results: z.array(BraveResult).default([]) });
const Query = z.object({ more_results_available: laxBool().default(false) });
const BraveResponse = z.object({
	web: Web.default({ results: [] }),
	query: Query.default({ more_results_available: false }),
});
export type BraveResponse = z.output<typeof BraveResponse>;

const TAGS = /<[^>]*>/g;
const SPACES = /\s+/g;

/** Snippets may carry markup for highlighting; keep only the text. */
export function plain(text: string): string {
	return htmlUnescape(text.replace(TAGS, "")).replace(SPACES, " ").trim();
}

function unavailable(): OperationError {
	return new OperationError("SEARCH_UNAVAILABLE", "Web search is not available on this Minerva instance right now.");
}

export class BraveSearch {
	readonly #http: ProviderHTTP;

	constructor(apiKey: string, io: ProviderIo) {
		this.#http = new ProviderHTTP(io, {
			provider: "Brave Search",
			baseUrl: BASE_URL,
			headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
			timeout: 15,
		});
	}

	async close(): Promise<void> {
		await this.#http.close();
	}

	async search(query: string, options: { count: number; page: number; country: string | null; freshness: string | null }): Promise<BraveResponse> {
		const params: { [name: string]: string | number } = {
			q: query,
			count: options.count,
			offset: options.page,
			safesearch: "moderate",
			text_decorations: "false",
			result_filter: "web",
		};
		if (options.country) params.country = options.country;
		if (options.freshness) params.freshness = options.freshness;
		let body: unknown;
		try {
			body = await this.#http.json({ method: "GET", path: "web/search", query: params });
		} catch (error) {
			if (error instanceof OperationError && (error.code === "CONNECTION_UNAUTHORIZED" || error.code === "PROVIDER_FORBIDDEN")) {
				console.error(`Brave Search refused the configured API key (${error.code}).`);
				throw unavailable();
			}
			throw error;
		}
		const parsed = BraveResponse.safeParse(body);
		if (!parsed.success) throw this.#http.unexpected(parsed.error);
		return parsed.data;
	}
}
