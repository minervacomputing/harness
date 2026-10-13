// The Web: searching it and reading pages, with access
// chosen per site.
//
// Opening an address sends whatever is in it to that site, so the sites an agent may read are also where it
// could carry data out. Access is per exact host or per domain with its subdomains, never wider than a
// registrable domain unless the user allows every site. Sites are a hierarchical kind whose ids are
// canonical host names or `*.domain` patterns (lib/sites.ts). Reading a page only parses the address before
// authorization; fetching happens after it (fetch.ts).
//
// Searching sends the query to the search provider, so it is a need on the account resource, its own
// permission on the connection. Search results carry addresses and snippets only; reading a result is a
// separate call that needs the site's permission. The instance provides the service (`builtin` auth), and
// without a Brave Search key (MINERVA_BRAVE_SEARCH_API_KEY) the connector withholds search (`offered`).

import { z } from "zod";
import type { Binding, Connector, Prepared, ProviderClient, ProviderIo, ProviderOutput, ScopedRecord } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { ACCOUNT_KIND, OperationError, defineOperation } from "../../gateway/connector.ts";
import { htmlToText } from "../../lib/markdown.ts";
import { MAX_URL, ancestors, canonicalHost, choices, name, parseUrl, validId } from "../../lib/sites.ts";
import { SINGLE_LINE, isSingleLine, sliceText } from "../../lib/text.ts";
import { Fetcher, Moved } from "./fetch.ts";
import { BraveSearch, MAX_PAGE, plain } from "./search.ts";

export const SITE = "site";
export const MAX_SNIPPET = 600;

export class WebClient implements ProviderClient {
	readonly fetcher: Fetcher;
	readonly search: BraveSearch | null;

	constructor(fetcher: Fetcher, search: BraveSearch | null) {
		this.fetcher = fetcher;
		this.search = search;
	}

	async close(): Promise<void> {
		await this.search?.close();
	}
}

function clientOf(binding: Binding): WebClient {
	return binding.client as WebClient;
}

function site(binding: Binding, host: string): Resource {
	return binding.resource(SITE, host, ancestors(host));
}

const Search = z.strictObject({
	query: z.string().trim().min(1).max(400).refine(isSingleLine, SINGLE_LINE),
	limit: z.int().min(1).max(20).default(10),
	// Where results should come from, as a two-letter country code (CH, DE, US).
	country: z.string().trim().regex(/^[A-Z]{2}$/).nullable().default(null),
	freshness: z.enum(["day", "week", "month", "year"]).nullable().default(null),
	cursor: z.string().trim().max(300).nullable().default(null),
});

const FRESHNESS: { readonly [name: string]: string } = { day: "pd", week: "pw", month: "pm", year: "py" };

/** The page a cursor names: its number when it is ASCII digits, else the first. */
function cursorPage(cursor: string | null): number {
	return cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
}

export const SEARCH = defineOperation<z.output<typeof Search>>({
	name: "search",
	title: "Search the web",
	description:
		"Search the web. Returns titles, addresses and short snippets, not page contents. To get more results, repeat the call with identical arguments plus the returned next_cursor.",
	input: Search,
	needs: [[ACCOUNT_KIND, "search"]],
	outputAction: "search",
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const page = cursorPage(data.cursor);
		if (data.cursor && !(page >= 1 && page <= MAX_PAGE)) throw new OperationError("INVALID_ARGUMENTS", "Invalid arguments. cursor: unknown page");
		const account = binding.account();
		return {
			requirements: [{ need: account, action: "search" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				if (client.search === null) throw new OperationError("SEARCH_UNAVAILABLE", "Web search is not set up on this Minerva instance.");
				const response = await client.search.search(data.query, {
					count: data.limit,
					page,
					country: data.country,
					freshness: data.freshness ? (FRESHNESS[data.freshness] as string) : null,
				});
				const records: ScopedRecord[] = [];
				for (const result of response.web.results) {
					let url: ReturnType<typeof parseUrl>;
					try {
						url = parseUrl(result.url);
					} catch (error) {
						if (error instanceof OperationError) continue;
						throw error;
					}
					records.push({
						resource: account,
						data: {
							title: plain(result.title),
							url: url.href,
							site: url.host,
							snippet: sliceText(plain(result.description), 0, MAX_SNIPPET),
							age: result.age,
						},
					});
				}
				const more = response.query.more_results_available && page < MAX_PAGE;
				return { records, nextCursor: more ? String(page + 1) : null };
			},
		};
	},
});

const ReadPage = z.strictObject({
	url: z.string().trim().min(1).max(MAX_URL),
	max_chars: z.int().min(500).max(100_000).default(20_000),
	// Where to start in the page's text, to continue a long page.
	offset: z.int().min(0).max(10_000_000).default(0),
});

const MOVED_NOTE = "This page moved to another address. Open redirect_to to follow it; that site needs its own permission.";

export const READ_PAGE = defineOperation<z.output<typeof ReadPage>>({
	name: "read_page",
	title: "Read a web page",
	description:
		"Open a web page (http or https) and read it as text. Only sites you may read can be opened. A page that moves to another site returns redirect_to instead of content. Long pages are cut at max_chars; continue with offset set to the returned next_offset.",
	input: ReadPage,
	needs: [[SITE, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		// Only parsed here; nothing is fetched before the site is authorized.
		const target = parseUrl(data.url);
		return {
			requirements: [{ need: site(binding, target.host), action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const outcome = await clientOf(binding).fetcher.get(target);
				if (outcome instanceof Moved) {
					return { records: [{ resource: site(binding, target.host), data: { url: target.href, redirect_to: outcome.target.href, note: MOVED_NOTE } }] };
				}
				let title: string | null = null;
				let text = outcome.text;
				if (outcome.form === "html") [text, title] = htmlToText(outcome.text, outcome.url.href);
				const end = data.offset + data.max_chars;
				const total = text.length;
				return {
					records: [
						{
							resource: site(binding, outcome.url.host),
							data: {
								url: outcome.url.href,
								title,
								content_type: outcome.contentType,
								text: sliceText(text, data.offset, end),
								offset: data.offset,
								total_chars: total,
								next_offset: end < total ? end : null,
							},
						},
					],
				};
			},
		};
	},
});

/** `MINERVA_BRAVE_SEARCH_API_KEY` as the Worker is configured (nodejs_compat puts its bindings in `process.env`); null when unset. */
function configuredBraveKey(): string | null {
	const env = (globalThis as { process?: { env?: { [name: string]: string | undefined } } }).process?.env;
	const value = env?.MINERVA_BRAVE_SEARCH_API_KEY;
	return typeof value === "string" ? value : null;
}

export interface WebOptions {
	/** The operator's Brave Search key, read each time; null when unset. */
	braveKey?: () => string | null;
}

/** The Web connector. A fresh declaration; the registry freezes the one it is given. */
export function webConnector(options: WebOptions = {}): Connector<WebClient> {
	const braveKey = options.braveKey ?? configuredBraveKey;
	return {
		slug: "web",
		name: "Web",
		kinds: [
			{ id: ACCOUNT_KIND, label: "Web search", actions: ["search"], note: "Searching sends the agent's query to Brave Search." },
			{
				id: SITE,
				label: "Site",
				actions: ["read"],
				wildcard: true,
				hierarchical: true,
				listed: false,
				note: "Search for a domain or paste an address to add it. An agent can send information to any site it may read, in the addresses it opens, so allow only sites you trust. A block on a domain wins over access to a wider one.",
			},
		],
		actions: [
			{ id: "search", label: "Search the web" },
			{ id: "read", label: "Read pages" },
		],
		auth: { type: "builtin" },
		operations: [SEARCH, READ_PAGE],

		offered(op) {
			return op.name !== "search" || braveKey() !== null;
		},

		client(_secret: string, io: ProviderIo) {
			const key = braveKey();
			// An empty key is set but refused nowhere: search is offered and then unavailable.
			return new WebClient(new Fetcher(io), key ? new BraveSearch(key, io) : null);
		},

		async account() {
			return { id: "web", label: "Web" };
		},

		async discover(_client, _kind, { query }) {
			if (!query) return { items: [] };
			const text = query.trim();
			// A pasted address, or a host name with or without a path.
			const slash = text.indexOf("/");
			const host = text.includes("://") ? parseUrl(text).host : canonicalHost(slash < 0 ? text : text.slice(0, slash));
			return { items: choices(host).map((item) => ({ id: item, name: name(item) })) };
		},

		async describe(_client, _kind, ids) {
			const names: { [id: string]: string } = {};
			for (const id of ids) if (validId(id)) names[id] = name(id);
			return names;
		},
	};
}
