// Linear. Resources are teams; what is allowed on a team also
// covers its sub-teams.
//
// Teams are one hierarchical kind (Linear has sub-teams), keyed by Linear's team id. Every issue belongs to
// one team, and everything about an issue is authorized on that team. Tools name teams by key ("ENG") and
// issues by identifier ("ENG-123"); a name is resolved to the team once, before authorization, and a team or
// issue the account cannot see is refused like one without a grant. Nothing that depends on what a call
// wants to read or write is looked up until the call is authorized. Just before content is read or written,
// the issue and its team's chain of parent teams are resolved again: a call whose issue or team moved in
// between is refused (`ISSUE_MOVED`, `TEAM_MOVED`).
//
// Text agents read hides the titles of other issues, which Linear writes into links (see `markdown`), and
// related issues in other teams are shown only as existing. Search matches titles only: Linear's text search
// also matches descriptions, so which issues matched would reveal words of other teams' titles held in their
// links. Text agents write may mention only issues in the same team of the connected workspace, checked
// after authorization. New issues skip the team's default template, which could add content Minerva did not
// check.
//
// Linear itself closes related issues in some cases (a parent whose sub-issues are all done, the open
// sub-issues of a closed parent), so a status change that could reach an issue in another team is refused:
// any status change when a parent issue at any level is in another team, and closing when an open sub-issue
// within three levels is in another team or sub-issues go deeper. What stays outside Minerva's reach: other
// Linear automations (triage rules, integrations), which may act on an issue an agent changed, and teams the
// connected account cannot see at all.
//
// Linear takes comma-separated scopes (`scopeSeparator: ","`). The base scope is `read`; writes ask for
// `issues:create`, `comments:create` or `write`, any of which older tokens may already cover.
//
// This module assembles the connector. The operations are in `reads` and `writes`; what they share (team
// and issue names, where teams sit, page tokens) is in `teams`.

import { type Connector, type DiscoveryItem, type DiscoveryPage, OperationError } from "../../gateway/connector.ts";
import { LinearClient, type Team } from "./client.ts";
import { GET_ISSUE, GET_TEAM, LIST_ISSUES, LIST_TEAMS, SEARCH_ISSUES } from "./reads.ts";
import { TEAM, UUID, checkedCursor, nextCursor } from "./teams.ts";
import { ADD_COMMENT, CREATE_ISSUE, UPDATE_ISSUE } from "./writes.ts";
import { extend } from "../../lib/arrays.ts";

export const MAX_DISCOVERY_PAGES = 10;
export const DESCRIBE_BATCH = 100;

function item(team: Team): DiscoveryItem {
	return { id: team.id.toLowerCase(), name: `${team.name} (${team.key})` };
}

export const linear: Connector<LinearClient> = {
	slug: "linear",
	name: "Linear",
	kinds: [
		{
			id: TEAM,
			label: "Team",
			actions: ["read", "comment", "create", "edit"],
			wildcard: true,
			hierarchical: true,
			note:
				"What is allowed on a team also covers its issues and its sub-teams. Minerva reaches the teams the connected Linear account can see. " +
				"Where Linear does not show a team's whole chain of parent teams, blocking an action anywhere in this connection also blocks it there.",
		},
	],
	actions: [
		{ id: "read", label: "Read issues" },
		{ id: "comment", label: "Comment on issues", requires: "read" },
		{ id: "create", label: "Create issues", requires: "read" },
		{ id: "edit", label: "Edit issues", requires: "read" },
	],
	tenancy: { kind: "account", label: "Linear workspace" },
	auth: {
		type: "oauth2",
		app: "linear",
		authorizeUrl: "https://linear.app/oauth/authorize",
		tokenUrl: "https://api.linear.app/oauth/token",
		scopes: ["read"],
		scopeSeparator: ",",
		clientAuth: "post",
		pkce: true,
	},
	operations: [LIST_TEAMS, GET_TEAM, LIST_ISSUES, SEARCH_ISSUES, GET_ISSUE, CREATE_ISSUE, ADD_COMMENT, UPDATE_ISSUE],

	client(secret, io) {
		return new LinearClient(io, secret);
	},

	async account(client) {
		const me = await client.me();
		return { id: me.viewer.id, label: `${me.viewer.name} (${me.organization.name})`, tenants: [{ id: me.organization.id, name: me.organization.name }] };
	},

	async discover(client, _kind, { query, cursor }): Promise<DiscoveryPage> {
		if (!query) {
			const found = await client.teams({ first: 100, after: checkedCursor(cursor) });
			return { items: found.nodes.map(item), nextCursor: nextCursor(found.pageInfo) };
		}
		const folded = query.toLowerCase();
		const matches: Team[] = [];
		let after: string | null = null;
		for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
			const found = await client.teams({ first: 100, after });
			extend(matches, found.nodes.filter((team) => team.name.toLowerCase().includes(folded) || team.key.toLowerCase().includes(folded)));
			after = nextCursor(found.pageInfo);
			if (after === null) return { items: matches.map(item), nextCursor: null };
		}
		throw new OperationError("PROVIDER_LIMIT", "There are more teams than Minerva can search.");
	},

	async describe(client, _kind, ids) {
		const wanted = ids.filter((teamId) => UUID.test(teamId));
		const batches: string[][] = [];
		for (let i = 0; i < wanted.length; i += DESCRIBE_BATCH) batches.push(wanted.slice(i, i + DESCRIBE_BATCH));
		const found = await Promise.all(batches.map((batch) => client.teams({ first: DESCRIBE_BATCH, after: null, ids: batch })));
		const names = new Map<string, string>();
		for (const page of found) for (const team of page.nodes) names.set(team.id.toLowerCase(), item(team).name);
		const described: { [id: string]: string } = {};
		for (const teamId of wanted) {
			const name = names.get(teamId);
			if (name !== undefined) described[teamId] = name;
		}
		return described;
	},
};
