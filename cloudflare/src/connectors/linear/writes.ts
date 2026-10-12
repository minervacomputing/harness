// Linear's write operations: creating and updating issues, and commenting
// (backend/connectors/linear/writes.py).

import { z } from "zod";
import type { Prepared, ProviderOutput } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, defineOperation } from "../../gateway/connector.ts";
import { casefold } from "../../lib/casefold.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { sortByCodePoint } from "../../lib/order.ts";
import { strippedStr } from "../../lib/schema.ts";
import { SINGLE_LINE, isSingleLine } from "../../lib/text.ts";
import { type LinearClient, MAX_ISSUE_DEPTH, type ParentIssue, type State, type Written } from "./client.ts";
import { issueLinks, redact, writtenProblem } from "./markdown.ts";
import { isoDate } from "../../lib/isoformat.ts";
import {
	CLOSED,
	IssueName,
	TEAM,
	TeamName,
	UUID,
	clientOf,
	confirmIssue,
	confirmTeam,
	hidden,
	issueMoved,
	resolveIssue,
	resolveTeam,
	samePlace,
	stateData,
} from "./teams.ts";

export const MAX_TITLE = 255;
export const MAX_DESCRIPTION = 50_000;
export const MAX_COMMENT = 20_000;
export const MAX_LABELS = 10;
/** How many levels of sub-issues a status change looks through for issues in other teams. */
export const SUB_ISSUE_DEPTH = 3;

export const NOT_AN_ID = "must be a Linear id";
export const NOT_A_DATE = "must be a date such as 2026-10-01";

const Title = () => strippedStr({ min: 1, max: MAX_TITLE }).refine(isSingleLine, SINGLE_LINE);
const ShortName = () => strippedStr({ min: 1, max: 200 }).refine(isSingleLine, SINGLE_LINE);
const Priority = () => z.int().min(0).max(4).describe("0 no priority, 1 urgent, 2 high, 3 medium, 4 low.");
/**
 * `DueDate | None = None`. Optional and defaulted inside the transform, so that the JSON Schema still shows
 * the default: zod leaves out the default of a field whose transform comes first.
 */
const DueDate = () =>
	strippedStr({ max: 10 })
		.describe("YYYY-MM-DD.")
		.nullable()
		.default(null)
		.refine((value) => value === null || isoDate(value) !== null, NOT_A_DATE)
		.transform((value) => (value === null ? null : (isoDate(value) as string)));

/** Markdown an agent writes, refused if it would do more than add words to Linear (`check_written`). */
const Markdown = (max: number, description: string) =>
	strippedStr({ min: 1, max })
		.describe(description)
		.superRefine((value, ctx) => {
			const problem = writtenProblem(value);
			if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
		});

const Assignee = () => strippedStr({ min: 1, max: 200 }).describe('"me", or a team member\'s name or display name.').refine(isSingleLine, SINGLE_LINE);
const LabelNames = () =>
	z
		.array(ShortName())
		.min(1)
		.max(MAX_LABELS)
		.describe('Label names; "Group/Label" picks a label inside a label group.');

export const WRITE_NOTE =
	"Everyone who can see the team sees what you write; subscribers are notified, assignees are notified, and the team's automations in Linear may make further changes.";
export const TEXT_NOTE =
	"Text is Markdown. It may link to Linear only with addresses of issues in the same team (https://linear.app/<workspace>/issue/<ID>), which Linear shows as mentions, and show images only from Linear's uploads.";

const CREATE_CONSENT = [["issues:create"], ["write"]];
const COMMENT_CONSENT = [["comments:create"], ["write"]];
const EDIT_CONSENT = [["write"]];

function linkRefused(): OperationError {
	return new OperationError(
		"LINK_NOT_ALLOWED",
		"Text may link only to issues in the same team of this Linear workspace: Linear turns such links into mentions, which show on the linked issue.",
	);
}

/**
 * Refuses text that links to an issue outside the team. Runs after authorization, so its answer tells
 * nothing about teams the agent may not read.
 */
async function checkLinks(client: LinearClient, teamId: string, written: string | null): Promise<void> {
	const links = written ? issueLinks(written) : [];
	if (!links.length) return;
	const workspace = (await client.organization()).urlKey.toLowerCase();
	for (const [linkWorkspace, identifier] of links) {
		if (linkWorkspace !== workspace) throw linkRefused();
		let team;
		try {
			team = await client.issueTeam(identifier);
		} catch (error) {
			if (hidden(error)) throw linkRefused();
			throw error;
		}
		if (team.id.toLowerCase() !== teamId) throw linkRefused();
	}
}

function unknownName(what: string): OperationError {
	return new OperationError("INVALID_ARGUMENTS", `No single ${what} in this team has that name; get_team lists them.`);
}

function pick<T>(items: T[], name: string, keys: (item: T) => (string | null)[], what: string): T {
	const folded = casefold(name);
	const found = items.filter((item) => keys(item).some((key) => key && casefold(key) === folded));
	if (found.length !== 1) throw unknownName(what);
	return found[0] as T;
}

async function stateId(client: LinearClient, teamId: string, name: string): Promise<State & { id: string }> {
	const [states] = await client.states(teamId);
	const state = pick(states, name, (item) => [item.name], "status");
	if (state.id === null) throw client.unexpected();
	return state as State & { id: string };
}

/** Python's f-string of an optional name: "None" for a missing one. */
function shown(name: string | null): string {
	return name === null ? "None" : name;
}

async function labelIds(client: LinearClient, teamId: string, names: string[]): Promise<string[]> {
	const labels = (await client.labels(teamId))[0].filter((label) => !label.isGroup);
	const picked = names.map((name) =>
		pick(labels, name, (label) => [label.name, label.parent ? `${shown(label.parent.name)}/${label.name}` : null], "label"),
	);
	return [...new Set(picked.map((label) => label.id))];
}

async function assigneeId(client: LinearClient, teamId: string, name: string): Promise<string> {
	if (casefold(name) === "me") return (await client.viewer()).id;
	const members = (await client.members(teamId))[0].filter((member) => member.active);
	return pick(members, name, (member) => [member.name, member.displayName], "member").id;
}

function writtenRecord(resource: Resource, written: Written | null, extra: JsonObject = {}): JsonObject {
	if (written === null || written.team.id.toLowerCase() !== resource.id) {
		// Linear confirmed the write but did not return the issue, or placed it in another team.
		return { written: true, ...extra };
	}
	return {
		written: true,
		id: written.id,
		identifier: written.identifier,
		title: written.title,
		state: stateData(written.state),
		url: redact(written.url),
		...extra,
	};
}

const CreateIssue = z.strictObject({
	team: TeamName(),
	title: Title(),
	description: Markdown(MAX_DESCRIPTION, "Markdown.").nullable().default(null),
	state: ShortName().nullable().default(null),
	priority: Priority().nullable().default(null),
	labels: LabelNames().nullable().default(null),
	assignee: Assignee().nullable().default(null),
	due_date: DueDate(),
}).meta({ title: "CreateIssue" });

export const CREATE_ISSUE = defineOperation<z.output<typeof CreateIssue>>({
	name: "create_issue",
	title: "Create an issue",
	description: `Create an issue in a team where you have create permission. Status, labels and assignee are names from get_team. ${TEXT_NOTE} ${WRITE_NOTE}`,
	input: CreateIssue,
	needs: [[TEAM, "create"]],
	consent: CREATE_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolveTeam(binding, data.team);
		return {
			requirements: [{ need: resource, action: "create" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				// A team's default template could add sub-issues or other content Minerva did not check.
				const input: JsonObject = { teamId: resource.id, title: data.title, useDefaultTemplate: false };
				if (data.description !== null) {
					await checkLinks(client, resource.id, data.description);
					input.description = data.description;
				}
				if (data.state !== null) {
					const state = await stateId(client, resource.id, data.state);
					if (CLOSED.includes(state.type)) throw new OperationError("INVALID_ARGUMENTS", "Create the issue open, then change its status.");
					input.stateId = state.id;
				}
				if (data.priority !== null) input.priority = data.priority;
				if (data.labels?.length) input.labelIds = await labelIds(client, resource.id, data.labels);
				if (data.assignee !== null) input.assigneeId = await assigneeId(client, resource.id, data.assignee);
				if (data.due_date !== null) input.dueDate = data.due_date;
				// Last before the write, so the team is checked as close to it as Linear allows.
				await confirmTeam(binding, resource);
				const created = await client.createIssue(input);
				return { records: [{ resource, data: writtenRecord(resource, created) }] };
			},
		};
	},
});

const AddComment = z.strictObject({
	issue: IssueName(),
	body: Markdown(MAX_COMMENT, "Markdown."),
	reply_to: strippedStr({ max: 36 })
		.describe("The id of a comment on this issue to reply to.")
		.nullable()
		.default(null)
		.refine((value) => value === null || UUID.test(value.toLowerCase()), NOT_AN_ID)
		.transform((value) => (value === null ? null : value.toLowerCase())),
}).meta({ title: "AddComment" });

export const ADD_COMMENT = defineOperation<z.output<typeof AddComment>>({
	name: "add_comment",
	title: "Comment on an issue",
	description: `Comment on an issue in a team where you have comment permission, optionally replying to one of its comments. ${TEXT_NOTE} ${WRITE_NOTE}`,
	input: AddComment,
	needs: [[TEAM, "comment"]],
	consent: COMMENT_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [issueId, resource] = await resolveIssue(binding, data.issue);
		return {
			requirements: [{ need: resource, action: "comment" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				const input: JsonObject = { issueId, body: data.body };
				if (data.reply_to !== null) {
					const notHere = () => new OperationError("INVALID_ARGUMENTS", "reply_to must be a comment on this issue.");
					let comment;
					try {
						comment = await client.commentPlace(data.reply_to);
					} catch (error) {
						if (hidden(error)) throw notHere();
						throw error;
					}
					if (comment.issue === null || comment.issue.id.toLowerCase() !== issueId || comment.id.toLowerCase() !== data.reply_to) throw notHere();
					// Linear threads are one level deep: a reply to a reply joins its thread.
					input.parentId = comment.parent ? comment.parent.id : comment.id;
				}
				await checkLinks(client, resource.id, data.body);
				const identifier = await confirmIssue(binding, issueId, resource);
				const created = await client.createComment(input);
				const record: JsonObject = {
					written: true,
					id: created ? created.id : null,
					issue: identifier,
					created_at: created ? created.createdAt : null,
					reply_to: (input.parentId as Json | undefined) ?? null,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const UpdateIssue = z
	.strictObject({
		issue: IssueName(),
		title: Title().nullable().default(null),
		description: Markdown(MAX_DESCRIPTION, "Markdown; replaces the whole description.").nullable().default(null),
		state: ShortName().nullable().default(null),
		priority: Priority().nullable().default(null),
		add_labels: LabelNames().nullable().default(null),
		remove_labels: LabelNames().nullable().default(null),
		assignee: Assignee().nullable().default(null),
		unassign: z.boolean().default(false),
		due_date: DueDate(),
		clear_due_date: z.boolean().default(false),
	})
	.superRefine((value, ctx) => {
		const problem = oneChange(value);
		if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
	})
	.meta({ title: "UpdateIssue" });

type UpdateFields = {
	title: string | null;
	description: string | null;
	state: string | null;
	priority: number | null;
	add_labels: string[] | null;
	remove_labels: string[] | null;
	assignee: string | null;
	unassign: boolean;
	due_date: string | null;
	clear_due_date: boolean;
};

/** The model validator's refusal, or null. */
function oneChange(value: UpdateFields): string | null {
	const changes = [value.title, value.description, value.state, value.priority, value.add_labels, value.remove_labels, value.assignee, value.due_date];
	if (changes.every((change) => change === null) && !value.unassign && !value.clear_due_date) return "change at least one field";
	if (value.assignee !== null && value.unassign) return "give either assignee or unassign";
	if (value.due_date !== null && value.clear_due_date) return "give either due_date or clear_due_date";
	const names = (labels: string[] | null) => (Array.isArray(labels) ? labels.filter((name) => typeof name === "string").map(casefold) : []);
	const added = new Set(names(value.add_labels));
	if (names(value.remove_labels).some((name) => added.has(name))) return "a label cannot be both added and removed";
	return null;
}

function statusRefused(): OperationError {
	return new OperationError(
		"STATUS_CHANGE_REFUSED",
		"Minerva does not change this issue's status: Linear could then close related issues in other teams (a parent issue, or open sub-issues) on its own.",
	);
}

/** Whether a parent issue, at any level, is in another team, or the chain goes beyond what was read. */
function parentsElsewhere(first: ParentIssue | null, teamId: string): boolean {
	let parent = first;
	for (let level = 0; level < MAX_ISSUE_DEPTH; level++) {
		if (parent === null) return false;
		if (parent.team.id.toLowerCase() !== teamId) return true;
		parent = parent.parent;
	}
	return parent !== null;
}

export const UPDATE_ISSUE = defineOperation<z.output<typeof UpdateIssue>>({
	name: "update_issue",
	title: "Update an issue",
	description:
		"Change an issue's title, description, status, priority, labels, assignee or due date, in a team where you have edit permission. " +
		"Issues cannot be moved to another team or parent. A status change is refused when Linear could then close related issues in other teams. " +
		`${TEXT_NOTE} ${WRITE_NOTE}`,
	input: UpdateIssue,
	needs: [[TEAM, "edit"]],
	consent: EDIT_CONSENT,
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		const [issueId, resource] = await resolveIssue(binding, data.issue);
		return {
			requirements: [{ need: resource, action: "edit" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				const input: JsonObject = {};
				if (data.title !== null) input.title = data.title;
				if (data.description !== null) {
					await checkLinks(client, resource.id, data.description);
					input.description = data.description;
				}
				let state: State | null = null;
				if (data.state !== null) {
					state = await stateId(client, resource.id, data.state);
					input.stateId = state.id;
				}
				if (data.priority !== null) input.priority = data.priority;
				if (data.add_labels?.length) input.addedLabelIds = await labelIds(client, resource.id, data.add_labels);
				if (data.remove_labels?.length) input.removedLabelIds = await labelIds(client, resource.id, data.remove_labels);
				if (data.assignee !== null) input.assigneeId = await assigneeId(client, resource.id, data.assignee);
				if (data.unassign) input.assigneeId = null;
				if (data.due_date !== null) input.dueDate = data.due_date;
				if (data.clear_due_date) input.dueDate = null;
				// Last before the write, so the issue is checked as close to it as Linear allows.
				let issue;
				try {
					issue = await client.issueForUpdate(issueId);
				} catch (error) {
					if (hidden(error)) throw issueMoved();
					throw error;
				}
				if (issue.id.toLowerCase() !== issueId || !samePlace(binding, resource, issue.team)) throw issueMoved();
				if (state !== null) {
					// Parent auto-close: a parent closes when its last sub-issue does.
					if (parentsElsewhere(issue.parent, resource.id)) throw statusRefused();
					// Sub-issue auto-close: closing a parent closes its open sub-issues.
					if (CLOSED.includes(state.type)) {
						const [elsewhere, deeper] = await client.openSubIssues(issueId, resource.id, SUB_ISSUE_DEPTH);
						if (elsewhere || deeper) throw statusRefused();
						// The lookup came after the check above; check the place again right before the write.
						await confirmIssue(binding, issueId, resource);
					}
				}
				const updated = await client.updateIssue(issueId, input);
				const record = writtenRecord(resource, updated, { changed: sortByCodePoint(Object.keys(input)) });
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
