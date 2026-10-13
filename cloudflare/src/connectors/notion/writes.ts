// Notion's write operations: creating and editing pages
// and rows, and commenting. Each sends exactly one write, from its execute step.

import { z } from "zod";
import type { Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import type { JsonObject } from "../../lib/json.ts";
import { record } from "../../lib/schema.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine } from "../../lib/text.ts";
import type { Page } from "./client.ts";
import { planEdits, showsSyncedContent, writtenRefusal } from "./markdown.ts";
import {
	JSON_SIZE_ERROR,
	PAGE,
	type Tree,
	canonical,
	commentData,
	dataSource,
	databaseResource,
	jsonSizeOk,
	moved,
	objectIdField,
	optionalObjectIdField,
	pageRecord,
	pageResource,
} from "./pages.ts";
import { type Properties, readable, writable } from "./properties.ts";

export const MAX_MARKDOWN = 100_000;
export const MAX_COMMENT = 2000;
export const MAX_PROPERTIES = 50;

/** `check_written` as a field check: the first refusal's reason is the message. */
function writtenOnly(value: string, ctx: z.RefinementCtx<string>): void {
	const refused = writtenRefusal(value);
	if (refused !== null) ctx.addIssue({ code: "custom", message: refused, input: value });
}

const titleField = () => z.string().trim().min(1).max(2000).refine(isSingleLine, SINGLE_LINE);
const markdownField = () =>
	z.string().trim().min(1).max(MAX_MARKDOWN).describe("Notion-flavored markdown.").refine(isPlainText, PLAIN_TEXT).superRefine(writtenOnly);
const propertiesField = () => record(z.unknown(), { min: 1, max: MAX_PROPERTIES }).refine(jsonSizeOk, JSON_SIZE_ERROR);

export const WRITE_TEXT_NOTE =
	"Text is Notion-flavored markdown without images, embeds, media, child page or database tags, synced blocks, or mentions of people.";

function titleOf(value: string): JsonObject {
	return { title: [{ type: "text", text: { content: value } }] };
}

/** The parent's ancestry, with the parent nearest. */
function inside(resource: Resource): string[] {
	return [resource.id, ...resource.within];
}

const CreatePage = z.strictObject({
	parent_page_id: objectIdField(),
	title: titleField(),
	markdown: markdownField().nullable().default(null),
});

export const CREATE_PAGE = defineOperation<z.output<typeof CreatePage>>({
	name: "create_page",
	title: "Create a page",
	description: `Create a Notion page inside a page where you have create permission, with a title and optional content. Everyone who can see the parent page can see it. ${WRITE_TEXT_NOTE}`,
	input: CreatePage,
	needs: [[PAGE, "create"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.parent_page_id);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				await tree.confirmPage(resource);
				const body: JsonObject = { parent: { page_id: resource.id }, properties: { title: titleOf(data.title) } };
				if (data.markdown) body.markdown = data.markdown;
				const created = await tree.client.createPage(body);
				const createdId = canonical(created.id) ?? created.id;
				return { records: [pageRecord(binding.resource(PAGE, createdId, inside(resource), resource.partial), created)] };
			},
		};
	},
});

const CreateRow = z.strictObject({
	database_id: objectIdField(),
	data_source_id: optionalObjectIdField(),
	properties: propertiesField(),
	markdown: markdownField().nullable().default(null),
});

export const CREATE_DATABASE_ROW = defineOperation<z.output<typeof CreateRow>>({
	name: "create_database_row",
	title: "Add a database row",
	description: `Add a row to a Notion database where you have create permission. properties maps property names to values: text, numbers, true/false, dates ("2026-10-01" or {"start", "end"}), and existing select, multi-select and status options (see get_database). Relations, people, files and computed properties cannot be set. Notion automations on the database may make further changes. ${WRITE_TEXT_NOTE}`,
	input: CreateRow,
	needs: [[PAGE, "create"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await databaseResource(binding, data.database_id);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const database = await tree.confirmDatabase(resource);
				const source = await dataSource(tree.client, database, data.data_source_id);
				const body: JsonObject = { parent: { data_source_id: source.id }, properties: writable(source.properties, data.properties as JsonObject) };
				if (data.markdown) body.markdown = data.markdown;
				const created = await tree.client.createPage(body);
				const createdId = canonical(created.id) ?? created.id;
				const row = binding.resource(PAGE, createdId, inside(resource), resource.partial);
				return { records: [pageRecord(row, created, { properties: readable(created.properties) })] };
			},
		};
	},
});

const UpdateProperties = z.strictObject({ page_id: objectIdField(), properties: propertiesField() });

/** The properties a page may have: its data source's for a database row, else only its title. */
async function pageSchema(tree: Tree, page: Page, resource: Resource): Promise<Properties> {
	const parent = page.parent;
	if (parent.type !== "data_source_id" && parent.type !== "database_id") return page.properties;
	const first = resource.within[0];
	if (first === undefined) throw moved();
	const database = await tree.client.database(first);
	const requested = parent.type === "data_source_id" ? canonical(parent.data_source_id) : null;
	const source = await dataSource(tree.client, database, requested);
	return source.properties;
}

export const UPDATE_PAGE_PROPERTIES = defineOperation<z.output<typeof UpdateProperties>>({
	name: "update_page_properties",
	title: "Update page properties",
	description:
		"Change properties of a Notion page where you have edit permission, with values as for create_database_row. A page outside a database has only its title. Notion automations may make further changes.",
	input: UpdateProperties,
	needs: [[PAGE, "edit"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				const page = await tree.confirmPage(resource);
				const properties = writable(await pageSchema(tree, page, resource), data.properties as JsonObject);
				const updated = await tree.client.updatePage(resource.id, { properties });
				return { records: [pageRecord(resource, updated, { properties: readable(updated.properties) })] };
			},
		};
	},
});

const Edit = z.strictObject({
	old: z.string().trim().min(1).max(10_000).describe("Text to replace, as read_page shows it."),
	new: z.string().trim().max(MAX_MARKDOWN).describe("Its replacement, in Notion-flavored markdown.").refine(isPlainText, PLAIN_TEXT).superRefine(writtenOnly),
});

const EditPage = z.strictObject({ page_id: objectIdField(), edits: z.array(Edit).min(1).max(20) });

export const EDIT_PAGE = defineOperation<z.output<typeof EditPage>>({
	name: "edit_page",
	title: "Edit a page",
	description: `Replace text in a Notion page where you have edit permission. Each old text must appear exactly once in the page as read_page shows it; lines linking to child pages, databases or mentioned pages cannot be edited, and nothing can be deleted along with child pages. ${WRITE_TEXT_NOTE}`,
	input: EditPage,
	needs: [[PAGE, "edit"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				const page = await tree.confirmPage(resource);
				const body = await tree.client.markdown(resource.id);
				if (body.truncated) throw new OperationError("PAGE_TOO_LARGE", "This page is too long for Minerva to edit.");
				if (showsSyncedContent(body.markdown)) throw new OperationError("UNSUPPORTED_PAGE", "This page shows synced content from another page. Minerva does not edit it.");
				const updates = planEdits(
					body.markdown,
					data.edits.map((edit) => [edit.old, edit.new] as const),
				);
				// Never allowed to delete: Notion then refuses edits that would remove child pages or databases.
				try {
					await tree.client.updateMarkdown(resource.id, {
						type: "update_content",
						update_content: { content_updates: updates.map((update) => ({ old_str: update.old_str, new_str: update.new_str })), allow_deleting_content: false },
					});
				} catch (error) {
					if (!(error instanceof OperationError) || error.code !== "PROVIDER_REJECTED") throw error;
					throw new OperationError(
						"EDIT_NOT_APPLIED",
						"Notion did not apply the edits: the page changed, or they would remove child pages or databases. Read the page and try again.",
					);
				}
				return { records: [pageRecord(resource, page, { edits: updates.length })] };
			},
		};
	},
});

const AppendToPage = z.strictObject({ page_id: objectIdField(), markdown: markdownField() });

export const APPEND_TO_PAGE = defineOperation<z.output<typeof AppendToPage>>({
	name: "append_to_page",
	title: "Append to a page",
	description: `Add content at the end of a Notion page where you have edit permission. ${WRITE_TEXT_NOTE}`,
	input: AppendToPage,
	needs: [[PAGE, "edit"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				const page = await tree.confirmPage(resource);
				await tree.client.updateMarkdown(resource.id, { type: "insert_content", insert_content: { content: data.markdown, position: { type: "end" } } });
				return { records: [pageRecord(resource, page)] };
			},
		};
	},
});

const AddComment = z.strictObject({
	page_id: objectIdField(),
	text: z.string().trim().min(1).max(MAX_COMMENT).describe("Inline Notion-flavored markdown.").refine(isPlainText, PLAIN_TEXT).superRefine(writtenOnly),
});

export const ADD_COMMENT = defineOperation<z.output<typeof AddComment>>({
	name: "add_comment",
	title: "Add a comment",
	description: `Comment on a Notion page where you have comment permission. People following the page may be notified. ${WRITE_TEXT_NOTE}`,
	input: AddComment,
	needs: [[PAGE, "comment"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [tree, resource] = await pageResource(binding, data.page_id);
		return {
			requirements: [{ need: resource, action: "comment" }],
			async execute(): Promise<ProviderOutput> {
				await tree.confirmPage(resource);
				const comment = await tree.client.addComment({ parent: { page_id: resource.id }, markdown: data.text });
				return { records: [{ resource, data: commentData(comment) }] };
			},
		};
	},
});
