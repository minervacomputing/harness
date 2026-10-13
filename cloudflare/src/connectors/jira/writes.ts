// Jira's write operations: commenting, creating issues and
// changing their status.

import { z } from "zod";
import type { Consent, Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import { casefold } from "../../lib/casefold.ts";
import type { JsonObject } from "../../lib/json.ts";
import { sortByCodePoint } from "../../lib/order.ts";
import { PLAIN_TEXT, SINGLE_LINE, isPlainText, isSingleLine } from "../../lib/text.ts";
import * as adf from "../atlassian/adf.ts";
import { ID, PROJECT, confirmIssue, hosts, issueName, link, projectName, projectResource, resolveIssue, resolveProject, siteId } from "./issues.ts";
import type { JiraClient, Transition } from "./client.ts";

export const MAX_SUMMARY = 255;
export const MAX_DESCRIPTION = 30_000;
export const MAX_COMMENT = 20_000;
export const MAX_LISTED = 30;

const WRITE_CONSENT: Consent = [["write:jira-work"]];

const shortName = () => z.string().trim().min(1).max(200).refine(isSingleLine, SINGLE_LINE);
/** Text that only adds words (adf.check_written): plain text, without an address to Atlassian. */
const written = (schema: z.ZodString) => schema.refine(isPlainText, PLAIN_TEXT).refine(adf.namesNoAtlassian, adf.ATLASSIAN_ADDRESS);
export const TEXT_DESCRIPTION = "Plain text, shown literally: no formatting, mentions or links to Atlassian.";
const summary = () => written(z.string().trim().min(1).max(MAX_SUMMARY).refine(isSingleLine, SINGLE_LINE));
const description = () => written(z.string().trim().min(1).max(MAX_DESCRIPTION).describe(TEXT_DESCRIPTION));
const commentText = () => written(z.string().trim().min(1).max(MAX_COMMENT).describe(TEXT_DESCRIPTION));

export const WRITE_NOTE =
	"Everyone who can browse the project sees what you write, posted as the signed-in user; watchers are notified, and the project's automation rules in Jira may make further changes.";

export function names(values: readonly (string | null)[]): string {
	const sorted = sortByCodePoint(new Set(values.filter((value): value is string => Boolean(value))));
	const shown = sorted.slice(0, MAX_LISTED).join(", ");
	return shown ? shown + (sorted.length > MAX_LISTED ? ", …" : "") : "none";
}

const AddComment = z.strictObject({ site_id: siteId().nullable().default(null), issue: issueName(), text: commentText() });

export const ADD_COMMENT = defineOperation<z.output<typeof AddComment>>({
	name: "add_comment",
	title: "Comment on an issue",
	description: `Add a comment to a Jira issue in a project where you have comment permission. ${WRITE_NOTE}`,
	input: AddComment,
	needs: [[PROJECT, "comment"]],
	consent: WRITE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, issueId] = await resolveIssue(binding, data.site_id, data.issue);
		adf.checkHosts(data.text, hosts(await (binding.client as JiraClient).sites()));
		return {
			requirements: [{ need: resource, action: "comment" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				const issue = await confirmIssue(binding, site, resource, issueId, "project");
				const comment = await client.addComment(site.id, issueId, adf.written(data.text));
				const record: JsonObject = {
					written: true,
					id: comment.id,
					issue_id: issueId,
					issue_key: issue.key,
					created: comment.created,
					link: link(site, issue.key),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const CreateIssue = z.strictObject({
	site_id: siteId().nullable().default(null),
	project: projectName(),
	issue_type: shortName().describe('An issue type\'s name in the project, such as "Task".'),
	summary: summary(),
	description: description().nullable().default(null),
});

export const CREATE_ISSUE = defineOperation<z.output<typeof CreateIssue>>({
	name: "create_issue",
	title: "Create an issue",
	description: `Create an issue in a Jira project where you have create permission. Projects that require further fields are refused by Jira. ${WRITE_NOTE}`,
	input: CreateIssue,
	needs: [[PROJECT, "create"]],
	consent: WRITE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, project] = await resolveProject(binding, data.site_id, data.project);
		adf.checkHosts(`${data.summary}\n${data.description ?? ""}`, hosts(await (binding.client as JiraClient).sites()));
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				// Sub-tasks need a parent issue, which this operation does not take.
				const types = (await client.issueTypes(site.id, project.id)).filter((type) => !type.subtask && type.id);
				const folded = casefold(data.issue_type);
				const matching = types.filter((type) => type.name && casefold(type.name) === folded);
				if (matching.length !== 1) {
					throw new OperationError("INVALID_ARGUMENTS", `No single issue type in this project has that name. Types: ${names(types.map((type) => type.name))}.`);
				}
				const fields: JsonObject = { project: { id: project.id }, issuetype: { id: matching[0]?.id ?? null }, summary: data.summary };
				if (data.description !== null) fields.description = adf.written(data.description);
				const created = await client.createIssue(site.id, fields);
				if (!ID.test(created.id)) throw client.unexpected();
				// Automation can move a new issue at once: the record names the project the issue is in now.
				const issue = await client.issue(site.id, created.id, "project");
				if (issue.id !== created.id || issue.fields.project === null) throw client.unexpected();
				const record: JsonObject = {
					written: true,
					id: issue.id,
					key: issue.key,
					site_id: site.id,
					project_id: issue.fields.project.id,
					link: link(site, issue.key),
				};
				return { records: [{ resource: projectResource(binding, site, issue.fields.project.id), data: record }] };
			},
		};
	},
});

const TransitionIssue = z.strictObject({
	site_id: siteId().nullable().default(null),
	issue: issueName(),
	status: shortName().describe("The status to move the issue to, or the name of the transition."),
});

export function pick(transitions: readonly Transition[], wanted: string): Transition {
	const folded = casefold(wanted);
	const byStatus = transitions.filter((transition) => transition.to?.name && casefold(transition.to.name) === folded);
	const byName = transitions.filter((transition) => transition.name && casefold(transition.name) === folded);
	for (const found of [byStatus, byName]) {
		if (new Set(found.map((transition) => transition.id)).size === 1) return found[0] as Transition;
	}
	const targets = names(transitions.map((transition) => (transition.to ? transition.to.name : null)));
	throw new OperationError("INVALID_ARGUMENTS", `No single transition of this issue leads to that status. Statuses it can move to: ${targets}.`);
}

export const TRANSITION_ISSUE = defineOperation<z.output<typeof TransitionIssue>>({
	name: "transition_issue",
	title: "Change an issue's status",
	description: `Move a Jira issue to another status through its workflow, in a project where you have change status permission. Transitions that ask for further fields are refused by Jira. ${WRITE_NOTE}`,
	input: TransitionIssue,
	needs: [[PROJECT, "transition"]],
	consent: WRITE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [site, resource, issueId] = await resolveIssue(binding, data.site_id, data.issue);
		return {
			requirements: [{ need: resource, action: "transition" }],
			async execute(): Promise<ProviderOutput> {
				const client = binding.client as JiraClient;
				const transitions = await client.transitions(site.id, issueId);
				// After reading the transitions, so their names are shown only of an issue still in the project,
				// and as close to the write as Jira allows.
				const issue = await confirmIssue(binding, site, resource, issueId, "project");
				const transition = pick(transitions, data.status);
				await client.transition(site.id, issueId, transition.id);
				const record: JsonObject = {
					written: true,
					issue_id: issueId,
					issue_key: issue.key,
					status: transition.to ? transition.to.name : null,
					link: link(site, issue.key),
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
