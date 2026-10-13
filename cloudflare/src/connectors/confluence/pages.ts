// What Confluence's operations share: sites, space and
// page names, and where pages sit.

import { z } from "zod";
import { type Binding, OperationError, denied } from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { CLOUD_ID, type Site } from "../atlassian/index.ts";
import type { ConfluenceClient, Page, Space } from "./client.ts";

export const SPACE = "space";
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN"]);

/** ASCII digits only. */
export const ID = /^\d{1,18}$/u;
/** Ids as calls give them: written as Confluence writes them, so another spelling cannot tell an existing space from a missing one. */
export const CANONICAL_ID = /^[1-9]\d{0,17}$/u;
export const SPACE_KEY = /^~?[A-Za-z0-9_:-]{1,255}$/;

export const SITE_ID_DESCRIPTION = "The site's id, from list_spaces. Needed only when the connection reaches several sites.";
const PAGE_DESCRIPTION = "A page id, from search_pages or a page's link.";

/** A site's cloud id, in lower case. */
export function siteId() {
	return z.string().trim().min(36).max(36)
		.describe(SITE_ID_DESCRIPTION)
		.refine((value) => CLOUD_ID.test(value.toLowerCase()), "must be a site id from list_spaces")
		.transform((value) => value.toLowerCase());
}

/** A space key (the key's own case) or id; digits alone are an id. */
export function spaceName() {
	return z.string().trim().min(1).max(256)
		.describe('A space key such as "ENG" (keys are case-sensitive), or a space id. Digits alone are an id.')
		.refine((value) => CANONICAL_ID.test(value) || (SPACE_KEY.test(value) && !/^[0-9]+$/.test(value)), 'must be a space key such as "ENG", or a space id');
}

/** A page id, as Confluence writes it. */
export function pageName() {
	return z.string().trim().min(1).max(18).describe(PAGE_DESCRIPTION).refine((value) => CANONICAL_ID.test(value), "must be a page id");
}

export function unseen(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

export function pageMoved(): OperationError {
	return new OperationError("PAGE_MOVED", "This page moved in Confluence while Minerva was using it, or access was lost. Try again.");
}

export function spaceId(site: Site, space: string): string {
	return `${site.id}/${space}`;
}

/** The resource of a space Confluence named. A malformed id fails rather than being guessed. */
export function spaceResource(binding: Binding, site: Site, space: string | null | undefined): Resource {
	if (space === null || space === undefined || !ID.test(space)) throw (binding.client as ConfluenceClient).unexpected();
	return binding.resource(SPACE, spaceId(site, space), [site.id]);
}

/** The hosts of the connection's sites, whose addresses text hides as links to Atlassian. */
export function hosts(sites: readonly Site[]): string[] {
	return sites.map((site) => site.host).filter((host): host is string => Boolean(host));
}

/** The space a call names, by id or key. One the account cannot see is refused like one without a grant. */
export async function resolveSpace(binding: Binding, siteId: string | null, name: string): Promise<[Site, Resource, Space]> {
	const client = binding.client as ConfluenceClient;
	const site = await client.site(siteId);
	let space: Space;
	if (ID.test(name)) {
		try {
			space = await client.space(site.id, name);
		} catch (error) {
			if (unseen(error)) throw denied();
			throw error;
		}
		if (space.id !== name) throw client.unexpected();
	} else {
		// Keys are matched exactly: Confluence's filter is case-sensitive, and only a space whose key is the one
		// asked for counts.
		const found = (await client.spacesBy(site.id, "keys", [name])).filter((candidate) => candidate.key === name);
		if (found.length !== 1) throw denied();
		space = found[0] as Space;
	}
	return [site, spaceResource(binding, site, space.id), space];
}

/**
 * The page a call names and the space it is in now. Drafts, archived and trashed pages, and pages the account
 * cannot see, are refused like pages without a grant.
 */
export async function resolvePage(binding: Binding, siteId: string | null, name: string): Promise<[Site, Resource, Page]> {
	const client = binding.client as ConfluenceClient;
	const site = await client.site(siteId);
	let page: Page;
	try {
		page = await client.page(site.id, name);
	} catch (error) {
		if (unseen(error)) throw denied();
		throw error;
	}
	if (page.id !== name || page.status !== "current") throw denied();
	return [site, spaceResource(binding, site, page.spaceId), page];
}

/** The page read again by id, refused unless it is current and still in the space it was authorized in. */
export async function confirmPage(binding: Binding, site: Site, resource: Resource, pageId: string, options: { body?: boolean } = {}): Promise<Page> {
	const client = binding.client as ConfluenceClient;
	let page: Page;
	try {
		page = await client.page(site.id, pageId, options);
	} catch (error) {
		if (unseen(error)) throw pageMoved();
		throw error;
	}
	if (page.id !== pageId || page.status !== "current" || page.spaceId === null) throw pageMoved();
	if (spaceId(site, page.spaceId) !== resource.id) throw pageMoved();
	return page;
}

export function link(site: Site, pageId: string): string | null {
	return site.host ? `https://${site.host}/wiki/pages/viewpage.action?pageId=${pageId}` : null;
}
