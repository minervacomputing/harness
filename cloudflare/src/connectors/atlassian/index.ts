// What Atlassian connectors share: OAuth 2.0 (3LO),
// the sites a token reaches, and a client base.
//
// Atlassian allows one callback URL per OAuth app, so each connector has its own app (`MINERVA_JIRA_*`,
// `MINERVA_CONFLUENCE_*`). Every connector asks for `offline_access read:me` and its own scopes. Atlassian
// rotates refresh tokens; Minerva stores each new one.
//
// One token can reach several sites (a site is one Atlassian cloud: `example.atlassian.net`), the ones the
// user picked on Atlassian's consent screen. `accessible-resources` lists them with the scopes granted on
// each; Minerva keeps the sites that granted the connector's base scope, once each, ordered by id, and calls
// each site's API through `api.atlassian.com/ex/<product>/<cloud id>`. Atlassian's own error texts never
// reach the model.

import { z } from "zod";
import type { Auth, ProviderClient, ProviderIo } from "../../contracts/connectors.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import { ProviderHTTP, segment } from "../../gateway/http.ts";
import { fromUtf8Strict } from "../../lib/bytes.ts";
import { type Json, parseJson } from "../../lib/json.ts";
import { model, optionalStr } from "./model.ts";

export const API_URL = "https://api.atlassian.com";
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_SITES = 50;
/** Cloud ids are UUIDs; Minerva keeps them in lower case. */
export const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SITE_URL = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function oauth(app: string, ...scopes: string[]): Extract<Auth, { type: "oauth2" }> {
	return {
		type: "oauth2",
		app,
		authorizeUrl: "https://auth.atlassian.com/authorize",
		tokenUrl: "https://auth.atlassian.com/oauth/token",
		scopes: ["offline_access", "read:me", ...scopes],
		authorizeParams: [
			["audience", "api.atlassian.com"],
			["prompt", "consent"],
		],
		jsonBody: true,
		// Atlassian does not document PKCE for 3LO; the state still binds the flow to the browser.
		pkce: false,
	};
}

export const MeModel = model({ account_id: z.string(), name: optionalStr, email: optionalStr });
export type Me = z.output<typeof MeModel>;

const SiteModel = model({ id: z.string(), name: optionalStr, url: optionalStr, scopes: z.array(z.string()).default([]) });

/** A site (one Atlassian cloud) as `accessible-resources` lists it. */
export class Site {
	readonly id: string;
	readonly name: string | null;
	readonly url: string | null;
	readonly scopes: readonly string[];

	constructor(fields: { id: string; name: string | null; url: string | null; scopes: readonly string[] }) {
		this.id = fields.id;
		this.name = fields.name;
		this.url = fields.url;
		this.scopes = fields.scopes;
	}

	static parse(value: unknown): Site | null {
		const parsed = SiteModel.safeParse(value);
		return parsed.success ? new Site(parsed.data) : null;
	}

	/** The site's host, when Atlassian gave a usable address. */
	get host(): string | null {
		const url = (this.url || "").toLowerCase().replace(/\/+$/, "");
		return SITE_URL.test(url) ? url.slice("https://".length) : null;
	}

	get label(): string {
		const host = this.host;
		const name = this.name || host || this.id;
		return host && host !== name ? `${name} (${host})` : name;
	}

	withId(id: string): Site {
		return new Site({ id, name: this.name, url: this.url, scopes: this.scopes });
	}
}

/** JSON's text from bytes as `json.loads` reads them: UTF-8, a byte order mark skipped, invalid UTF-8 refused. */
function jsonText(bytes: Uint8Array): string {
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	return fromUtf8Strict(bytes.subarray(start));
}

/** Base of the Atlassian clients: authenticated, bounded reads, validated responses. */
export class AtlassianClient implements ProviderClient {
	readonly provider: string;
	readonly product: string;
	/** The scope a site must have granted for this connector to use it. */
	readonly scope: string;
	readonly http: ProviderHTTP;
	#sites: Site[] | null = null;

	constructor(provider: string, product: string, accessToken: string, io: ProviderIo, scope: string) {
		this.provider = provider;
		this.product = product;
		this.scope = scope;
		this.http = new ProviderHTTP(io, {
			provider,
			baseUrl: API_URL,
			headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
		});
	}

	close(): Promise<void> {
		return this.http.close();
	}

	unexpected(cause?: unknown): OperationError {
		return this.http.unexpected(cause);
	}

	/** The value read with `schema`; one that does not fit is an unexpected response. */
	parse<T>(schema: z.ZodType<T>, value: unknown): T {
		const parsed = schema.safeParse(value);
		if (!parsed.success) throw this.unexpected(parsed.error);
		return parsed.data;
	}

	#tooLarge(): OperationError {
		return new OperationError("RESPONSE_TOO_LARGE", `${this.provider} returned more than Minerva reads.`);
	}

	async #json(response: Response): Promise<Json> {
		const bytes = new Uint8Array(await response.arrayBuffer());
		try {
			return parseJson(jsonText(bytes));
		} catch (error) {
			throw this.unexpected(error);
		}
	}

	async get(path: string, params?: { [name: string]: string }): Promise<Json> {
		return this.#json(await this.http.bounded({ method: "GET", path, ...(params === undefined ? {} : { query: params }) }, MAX_RESPONSE_BYTES, this.#tooLarge()));
	}

	/** A read Atlassian takes as a POST (bulk fetches); never accounted as a write. */
	async readPost(path: string, body: Json): Promise<Json> {
		return this.#json(await this.http.bounded({ method: "POST", path, json: body }, MAX_RESPONSE_BYTES, this.#tooLarge()));
	}

	/** The path prefix of a site's API. */
	api(cloudId: string): string {
		return `/ex/${this.product}/${segment(cloudId)}`;
	}

	async me(): Promise<Me> {
		return this.parse(MeModel, await this.get("/me"));
	}

	/** The sites this connection may use, once each, ordered by cloud id. */
	async sites(): Promise<Site[]> {
		if (this.#sites === null) {
			const body = await this.get("/oauth/token/accessible-resources");
			if (!Array.isArray(body)) throw this.unexpected();
			const found = new Map<string, Site>();
			for (const item of body) {
				const site = Site.parse(item);
				if (site === null) throw this.unexpected();
				const cloudId = site.id.toLowerCase();
				if (CLOUD_ID.test(cloudId) && site.scopes.includes(this.scope) && !found.has(cloudId)) found.set(cloudId, site.withId(cloudId));
			}
			if (found.size > MAX_SITES) throw new OperationError("PROVIDER_LIMIT", `This account reaches more ${this.provider} sites than Minerva reads.`);
			this.#sites = [...found.keys()].sort().map((key) => found.get(key) as Site);
		}
		return this.#sites;
	}

	/**
	 * The site a call names, or the only one this connection reaches. A site it does not reach is refused
	 * like one without a grant.
	 */
	async site(cloudId: string | null): Promise<Site> {
		const sites = await this.sites();
		if (cloudId === null) {
			if (sites.length !== 1) throw new OperationError("INVALID_ARGUMENTS", `This connection reaches ${sites.length} ${this.provider} sites; name one with site_id.`);
			return sites[0] as Site;
		}
		const wanted = cloudId.toLowerCase();
		const found = sites.find((site) => site.id === wanted);
		if (found === undefined) throw denied();
		return found;
	}
}
