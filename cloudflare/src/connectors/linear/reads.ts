// Linear's read operations: teams, issue lists and search, and single issues.

import { z } from "zod";
import { type Binding, type Prepared, type ProviderOutput, type ScopedRecord, defineOperation } from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import type { Json, JsonObject } from "../../lib/json.ts";
import { SINGLE_LINE, isSingleLine, truncate } from "../../lib/text.ts";
import { type IssueSummary, type Label, type Team, authorOf } from "./client.ts";
import { redact } from "./markdown.ts";
import {
	CLOSED,
	Cursor,
	IssueName,
	TEAM,
	TeamName,
	checkedCursor,
	clientOf,
	confirmTeam,
	issueMoved,
	nextCursor,
	resolveIssue,
	resolveTeam,
	samePlace,
	stateData,
	teamMoved,
	teamResource,
} from "./teams.ts";
import { compareText } from "../../lib/arrays.ts";

export const MAX_READ_DESCRIPTION = 20_000;
export const MAX_READ_COMMENT = 4_000;
export const MAX_COMMENTS = 30;
export const MAX_SEARCH_WORDS = 8;

const PAGES = "To get the next page, repeat the call with identical arguments plus the returned next_cursor.";

function teamData(resource: Resource, team: Team): JsonObject {
	return {
		id: resource.id,
		key: team.key,
		name: team.name,
		description: team.description,
		private: team.private,
		parent_team_id: resource.within[0] ?? null,
	};
}

function summary(issue: IssueSummary): JsonObject {
	return {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		state: stateData(issue.state),
		priority: issue.priorityLabel,
		assignee: issue.assignee ? issue.assignee.name : null,
		due_date: issue.dueDate,
		updated_at: issue.updatedAt,
		url: redact(issue.url),
	};
}

const ListTeams = z.strictObject({
	limit: z.int().min(1).max(100).default(50),
	cursor: Cursor(),
});

export const LIST_TEAMS = defineOperation<z.output<typeof ListTeams>>({
	name: "list_teams",
	title: "List teams",
	description: `List the Linear teams you may read, with their keys. ${PAGES}`,
	input: ListTeams,
	needs: [[TEAM, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ enumerate: TEAM, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const found = await clientOf(binding).teams({ first: data.limit, after: checkedCursor(data.cursor) });
				const records: ScopedRecord[] = found.nodes.map((team) => {
					const resource = teamResource(binding, team);
					return { resource, data: teamData(resource, team) };
				});
				return { records, nextCursor: nextCursor(found.pageInfo) };
			},
		};
	},
});

const TeamInput = z.strictObject({ team: TeamName() });

function labelData(label: Label): JsonObject {
	return { name: label.name, group: label.parent ? label.parent.name : null };
}

export const GET_TEAM = defineOperation<z.output<typeof TeamInput>>({
	name: "get_team",
	title: "Get a team",
	description:
		"Read a Linear team: its statuses, the labels its issues can have, and its members. Use these names when creating or updating issues.",
	input: TeamInput,
	needs: [[TEAM, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolveTeam(binding, data.team);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const client = clientOf(binding);
				const team = await confirmTeam(binding, resource);
				const [states, statesMore] = await client.states(resource.id);
				const [labels, labelsMore] = await client.labels(resource.id);
				const [members, membersMore] = await client.members(resource.id);
				const record: JsonObject = {
					...teamData(resource, team),
					states: states.map(stateData),
					labels: labels.filter((label) => !label.isGroup).map(labelData),
					members: members.filter((person) => person.active).map((person) => ({ name: person.name, display_name: person.displayName })),
					truncated: statesMore || labelsMore || membersMore,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});

const StateFilter = () => z.enum(["open", "closed", "all"]);

const ListIssues = z.strictObject({
	team: TeamName(),
	state: StateFilter().default("open"),
	assigned_to_me: z.boolean().default(false),
	limit: z.int().min(1).max(50).default(25),
	cursor: Cursor(),
});

function stateCondition(state: "open" | "closed" | "all"): JsonObject[] {
	if (state === "open") return [{ state: { type: { nin: [...CLOSED] } } }];
	if (state === "closed") return [{ state: { type: { in: [...CLOSED] } } }];
	return [];
}

async function issuePage(binding: Binding, resource: Resource, conditions: JsonObject[], limit: number, cursor: string | null): Promise<ProviderOutput> {
	const found = await clientOf(binding).teamIssues(resource.id, {
		first: limit,
		after: checkedCursor(cursor),
		filter: conditions.length ? { and: conditions } : null,
	});
	if (!samePlace(binding, resource, found)) throw teamMoved();
	const records: ScopedRecord[] = found.issues.nodes
		.filter((issue) => issue.team.id.toLowerCase() === resource.id)
		.map((issue) => ({ resource, data: summary(issue) }));
	return { records, nextCursor: nextCursor(found.issues.pageInfo) };
}

export const LIST_ISSUES = defineOperation<z.output<typeof ListIssues>>({
	name: "list_issues",
	title: "List issues",
	description: `List a team's issues, most recently updated first; open ones by default. Sub-teams' issues are not included. ${PAGES}`,
	input: ListIssues,
	needs: [[TEAM, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolveTeam(binding, data.team);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const conditions = stateCondition(data.state);
				if (data.assigned_to_me) conditions.push({ assignee: { isMe: { eq: true } } });
				return issuePage(binding, resource, conditions, data.limit, data.cursor);
			},
		};
	},
});

const SearchIssues = z.strictObject({
	team: TeamName(),
	query: z.string().trim().min(1).max(200).describe("Words that must all appear in the title.").refine(isSingleLine, SINGLE_LINE),
	state: StateFilter().default("all"),
	limit: z.int().min(1).max(50).default(25),
	cursor: Cursor(),
});

export const SEARCH_ISSUES = defineOperation<z.output<typeof SearchIssues>>({
	name: "search_issues",
	title: "Search issues",
	description: `Find one team's issues whose title contains every word of the query (descriptions and comments are not searched). ${PAGES}`,
	input: SearchIssues,
	needs: [[TEAM, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		const resource = await resolveTeam(binding, data.team);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				// Titles only: Linear's text search also matches descriptions, whose links carry titles of issues
				// in other teams, so which issues matched would reveal words of those titles.
				const words = data.query.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
				const conditions = [...stateCondition(data.state), ...words.map((word) => ({ title: { containsIgnoreCase: word } }))];
				return issuePage(binding, resource, conditions, data.limit, data.cursor);
			},
		};
	},
});

export const READ_NOTE = "Links to other Linear objects appear without their titles, and related issues in other teams only as existing.";

const IssueInput = z.strictObject({ issue: IssueName() });

export const GET_ISSUE = defineOperation<z.output<typeof IssueInput>>({
	name: "get_issue",
	title: "Read an issue",
	description: `Read one Linear issue with its description, sub-issues and first comments. ${READ_NOTE}`,
	input: IssueInput,
	needs: [[TEAM, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		const [issueId, resource] = await resolveIssue(binding, data.issue);
		return {
			requirements: [{ need: resource, action: "read" }],
			async execute(): Promise<ProviderOutput> {
				const issue = await clientOf(binding).issue(issueId, MAX_COMMENTS);
				if (issue.id.toLowerCase() !== issueId || !samePlace(binding, resource, issue.team)) throw issueMoved();
				const [description, descriptionTruncated] = truncate(redact(issue.description), MAX_READ_DESCRIPTION);
				let parent: JsonObject | null = null;
				if (issue.parent !== null) {
					parent =
						issue.parent.team.id.toLowerCase() === resource.id
							? { identifier: issue.parent.identifier, title: issue.parent.title }
							: { in_another_team: true };
				}
				const children = issue.children.nodes;
				const comments: Json[] = [];
				const ordered = [...issue.comments.nodes].sort((a, b) => compareText(a.createdAt || "", b.createdAt || ""));
				for (const comment of ordered) {
					if (comment.hideInLinear) continue;
					const [body, bodyTruncated] = truncate(redact(comment.body), MAX_READ_COMMENT);
					comments.push({
						id: comment.id,
						author: authorOf(comment),
						body,
						body_truncated: bodyTruncated,
						created_at: comment.createdAt,
						reply_to: comment.parent ? comment.parent.id : null,
					});
				}
				const record: JsonObject = {
					id: issue.id,
					identifier: issue.identifier,
					title: issue.title,
					team: { id: resource.id, key: issue.team.key, name: issue.team.name },
					description,
					description_truncated: descriptionTruncated,
					state: stateData(issue.state),
					priority: issue.priorityLabel,
					estimate: issue.estimate,
					due_date: issue.dueDate,
					assignee: issue.assignee ? issue.assignee.name : null,
					creator: issue.creator ? issue.creator.name : null,
					project: issue.project ? issue.project.name : null,
					labels: issue.labels.nodes.map((label) => label.name),
					parent,
					sub_issues: children
						.filter((child) => child.team.id.toLowerCase() === resource.id)
						.map((child) => ({ identifier: child.identifier, title: child.title, state: stateData(child.state) })),
					sub_issues_in_other_teams: children.some((child) => child.team.id.toLowerCase() !== resource.id),
					sub_issues_truncated: issue.children.pageInfo.hasNextPage,
					url: redact(issue.url),
					created_at: issue.createdAt,
					updated_at: issue.updatedAt,
					completed_at: issue.completedAt,
					canceled_at: issue.canceledAt,
					comments,
					comments_truncated: issue.comments.pageInfo.hasNextPage,
				};
				return { records: [{ resource, data: record }] };
			},
		};
	},
});
