// Confluence's write operations: commenting on pages
// and creating them.
//
// Each write reads its page (or the new page's parent) again just before sending, and refuses one that
// moved. That cannot stop a move that lands between that read and the write; Confluence takes no condition
// on where a page is.

import { z } from "zod";
import type { Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import type { JsonObject } from "../../lib/json.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine } from "../../lib/text.ts";
import * as adf from "../atlassian/adf.ts";
import type { ConfluenceClient } from "./client.ts";
import { ID, SPACE, confirmPage, hosts, link, pageName, resolvePage, resolveSpace, siteId, spaceName, spaceResource } from "./pages.ts";

export const MAX_TITLE = 255;
export const MAX_BODY = 50_000;
export const MAX_COMMENT = 20_000;

export const TEXT_DESCRIPTION = "Plain text, shown literally: no formatting, mentions or links to Atlassian.";
/** Text that only adds words: plain text, without an address to Atlassian. */
const written = (schema: z.ZodString) => schema.refine(isPlainText, PLAIN_TEXT).refine(adf.namesNoAtlassian, adf.ATLASSIAN_ADDRESS);
const title = () => written(z.string().trim().min(1).max(MAX_TITLE).describe("The page's title, unique in its space.").refine(isSingleLine, SINGLE_LINE));
const bodyText = () => written(z.string().trim().min(1).max(MAX_BODY).describe(TEXT_DESCRIPTION));
const commentText = () => written(z.string().trim().min(1).max(MAX_COMMENT).describe(TEXT_DESCRIPTION));

export const WRITE_NOTE =
	"Everyone who can view the space sees what you write, posted as the signed-in user; watchers are notified, and the space's automation rules in Confluence may make further changes.";

const AddComment = z.strictObject({ site_id: siteId().nullable().default(null), page: pageName(), text: commentText() });

export const ADD_COMMENT = defineOperation<z.output<typeof AddComment>>({
	name: "add_comment",
	title: "Comment on a page",
	description: `Add a comment at the foot of a Confluence page in a space where you have comment permission. ${WRITE_NOTE}`,
	input: AddComment,
	needs: [[SPACE, "comment"]],
	consent: [["write:comment:confluence"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, page] = await resolvePage(binding, data.site_id, data.page);
		adf.checkHosts(data.text, hosts(await (binding.client as ConfluenceClient).sites()));
		return {
			requirements: [{ need: resource, action: "comment" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as ConfluenceClient;
				await confirmPage(binding, site, resource, page.id);
				const comment = await client.addComment(site.id, page.id, adf.written(data.text));
				const record: JsonObject = {
					written: true,
					id: comment.id,
					page_id: page.id,
					created: comment.version ? comment.version.createdAt : null,
					link: link(site, page.id),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const CreatePage = z.strictObject({
	site_id: siteId().nullable().default(null),
	space: spaceName(),
	title: title(),
	body: bodyText().nullable().default(null),
	parent_page: pageName()
		.nullable()
		.default(null)
		.describe("The id of a page in the same space to put the new page under; without one, under the space's homepage."),
});

export const CREATE_PAGE = defineOperation<z.output<typeof CreatePage>>({
	name: "create_page",
	title: "Create a page",
	description: `Create a page in a Confluence space where you have create permission. ${WRITE_NOTE}`,
	input: CreatePage,
	needs: [[SPACE, "create"]],
	consent: [["write:page:confluence"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, space] = await resolveSpace(binding, data.site_id, data.space);
		if (data.parent_page !== null) {
			// A parent elsewhere is refused like one the account cannot see: the authorization below is on this
			// space only, so a different answer would tell the agent where an unreadable page is not.
			const [, parentResource] = await resolvePage(binding, site.id, data.parent_page);
			if (parentResource.id !== resource.id) throw denied();
		}
		adf.checkHosts(`${data.title}\n${data.body ?? ""}`, hosts(await (binding.client as ConfluenceClient).sites()));
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as ConfluenceClient;
				if (data.parent_page !== null) await confirmPage(binding, site, resource, data.parent_page);
				let created: Awaited<ReturnType<ConfluenceClient["createPage"]>>;
				try {
					created = await client.createPage(site.id, { spaceId: space.id, title: data.title, parentId: data.parent_page, adf: adf.written(data.body ?? "") });
				} catch (error) {
					if (error instanceof OperationError && error.code === "PROVIDER_REJECTED") {
						throw new OperationError("INVALID_ARGUMENTS", "Confluence refused the page. A page with this title may already exist in the space.");
					}
					throw error;
				}
				if (!ID.test(created.id)) throw client.unexpected();
				// Automation can move a new page at once: the record names the space the page is in now.
				const page = await client.page(site.id, created.id);
				if (page.id !== created.id) throw client.unexpected();
				const record: JsonObject = {
					written: true,
					id: page.id,
					site_id: site.id,
					space_id: page.spaceId,
					link: link(site, page.id),
				};
				return { records: [{ resource: spaceResource(binding, site, page.spaceId), data: record }] };
			},
		};
	},
});
