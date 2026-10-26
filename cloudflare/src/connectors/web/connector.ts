// The Web: opening pages in Minerva's browser, with access chosen per site.
//
// Opening an address sends whatever is in it to that site, and the page's scripts run, so the sites an agent may open
// are also where it could carry data out and what it can act on as a visit would. Access is per exact host or per
// domain with its subdomains, never wider than a registrable domain unless the user allows every site. Sites are a
// hierarchical kind whose ids are canonical host names or `*.domain` patterns (lib/sites.ts), each in the tenant of
// its registrable domain, so an organization's connection policy can limit the Web to a list of domains. A host that
// is a public suffix itself (`co.uk`) has no domain and is refused here. Opening a page only parses the address before
// authorization; the browser opens it after (render.ts).

import { z } from "zod";
import {
	type Binding,
	type Connector,
	OperationError,
	type Prepared,
	type ProviderOutput,
	defineOperation,
	inTenant,
} from "../../gateway/connector.ts";
import type { ProviderIo } from "../../gateway/http.ts";
import type { Resource } from "../../gateway/policy.ts";
import { MAX_URL, PATTERN_PREFIX, WebURL, ancestors, canonicalHost, choices, isPattern, name, parseUrl, registrable, validId } from "../../lib/sites.ts";
import { sliceText } from "../../lib/text.ts";
import { Browser, Moved, type Visit } from "./render.ts";

export const SITE = "site";
const BROWSE = "browse";

function clientOf(binding: Binding): Browser {
	return binding.client as Browser;
}

function domainOf(id: string): string | null {
	return registrable(isPattern(id) ? id.slice(PATTERN_PREFIX.length) : id);
}

interface Target extends Visit {
	domain: string;
}

function targetOf(raw: string): Target {
	const parsed = parseUrl(raw);
	const domain = domainOf(parsed.host);
	if (domain === null) throw new OperationError("INVALID_URL", "This address has no domain Minerva can match.");
	const url = parsed.scheme === "https" ? parsed : new WebURL("https", parsed.host, `https:${parsed.href.slice("http:".length)}`);
	return { url, withFragment: url.href + (URL.parse(raw)?.hash ?? ""), domain };
}

function site(binding: Binding, target: Target): Resource {
	return inTenant(binding.resource(SITE, target.url.host, ancestors(target.url.host)), target.domain);
}

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
		"Open a web page in Minerva's browser, which runs its scripts, and read it as text. Only https pages on sites you may open. A page that moves to another site returns redirect_to instead of content. Long pages are cut at max_chars; continue with offset set to the returned next_offset, which opens the page again.",
	input: ReadPage,
	needs: [[SITE, BROWSE]],
	outputAction: BROWSE,
	revision: 2,
	async prepare(binding, data): Promise<Prepared> {
		const target = targetOf(data.url);
		return {
			requirements: [{ need: site(binding, target), action: BROWSE }],
			async execute(): Promise<ProviderOutput> {
				const page = await clientOf(binding).read(target);
				if (page instanceof Moved) {
					return { records: [{ resource: site(binding, target), data: { url: target.url.href, redirect_to: page.target.href, note: MOVED_NOTE } }] };
				}
				const end = data.offset + data.max_chars;
				const total = page.text.length;
				return {
					records: [
						{
							resource: site(binding, target),
							data: {
								url: page.url.href,
								title: page.title,
								content_type: page.contentType,
								text: sliceText(page.text, data.offset, end),
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

/** The Web connector. A fresh declaration; the registry freezes the one it is given. */
export function webConnector(): Connector<Browser> {
	return {
		slug: "web",
		name: "Web",
		kinds: [
			{
				id: SITE,
				label: "Site",
				actions: [BROWSE],
				wildcard: true,
				hierarchical: true,
				listed: false,
				note: "Search for a domain or paste an address to add it. Open in browser loads pages in Cloudflare's browser and runs their scripts, which can act on the site as a visit would, such as following a sign-in link. Agents can also send information in the addresses they open, to these sites and to wherever they redirect, so allow only sites you trust. A block on a domain wins over access to a wider one.",
			},
		],
		actions: [{ id: BROWSE, label: "Open in browser" }],
		auth: { type: "builtin" },
		tenancy: {
			kind: "resource",
			label: "domain",
			async tenants(_client, _kind, ids) {
				const found: { [id: string]: string } = {};
				for (const id of ids) {
					const domain = domainOf(id);
					if (domain !== null) found[id] = domain;
				}
				return found;
			},
		},
		operations: [READ_PAGE],

		client(_secret: string, io: ProviderIo) {
			return new Browser(io);
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
			const domain = domainOf(host);
			if (domain === null) return { items: [] };
			return { items: choices(host).map((item) => ({ id: item, name: name(item), tenant: domain })) };
		},

		async describe(_client, _kind, ids) {
			const names: { [id: string]: string } = {};
			for (const id of ids) if (validId(id) && domainOf(id) !== null) names[id] = name(id);
			return names;
		},
	};
}
