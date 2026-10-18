// Sentry, read-only. Resources are projects; agents list projects, search issues and read issues and their
// events.
//
// A connection is one user in one Sentry organisation: Sentry's consent screen asks which organisation, and
// the token reaches only that one (see client.ts). The account is the organisation and the user together, so
// one user can connect several organisations. The kind is flat: a project is keyed by its numeric id. Only
// sentry.io is supported, not self-hosted Sentry.
//
// Reading needs `org:read project:read event:read`, joined by spaces, with PKCE and the client in the token
// request's form (the generic OAuth flow's defaults). Sentry shows a member the projects of their teams, or
// all of them when the organisation allows open membership; what Sentry refuses is refused like what is not
// granted.
//
// This module assembles the connector. The operations are in reads.ts.

import { type Connector, OperationError } from "../../gateway/connector.ts";
import { ID, ONE_ORGANISATION, type Project, SentryClient } from "./client.ts";
import { GET_ISSUE, GET_ISSUE_EVENT, LIST_PROJECTS, PROJECT, SEARCH_ISSUES, short, unseen } from "./reads.ts";

export const MAX_DESCRIBE = 100;
export const CONCURRENCY = 8;

function projectName(project: Project): string {
	const name = short(project.name);
	return name && name !== project.slug ? `${name} (${project.slug})` : project.slug;
}

/** `run` over `items`, at most `limit` at a time, in order; the first failure fails it, and no item starts after. */
async function gathered<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await run(items[index] as T);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** A fresh declaration; the registry freezes the one it is given. */
export function sentryConnector(): Connector<SentryClient> {
	return {
		slug: "sentry",
		name: "Sentry",
		kinds: [
			{
				id: PROJECT,
				label: "Project",
				actions: ["read"],
				wildcard: true,
				note: "Agents read issues and events: stack traces, the source lines around them, and tags.",
			},
		],
		actions: [{ id: "read", label: "Read issues and events" }],
		tenancy: { kind: "account", label: "Sentry organization" },
		auth: {
			type: "oauth2",
			app: "sentry",
			authorizeUrl: "https://sentry.io/oauth/authorize/",
			tokenUrl: "https://sentry.io/oauth/token/",
			scopes: ["org:read", "project:read", "event:read"],
		},
		operations: [LIST_PROJECTS, SEARCH_ISSUES, GET_ISSUE, GET_ISSUE_EVENT],

		client(accessToken, io) {
			return new SentryClient(accessToken, io);
		},

		async account(client) {
			const user = await client.user();
			const organisations = await client.organisations();
			if (organisations.length !== 1) throw new OperationError("UNSUPPORTED_ACCOUNT", ONE_ORGANISATION);
			const organisation = organisations[0] as (typeof organisations)[number];
			const person = short(user.name && user.email ? `${user.name} (${user.email})` : user.name || user.email);
			const org = short(organisation.name) || organisation.slug;
			return { id: `${organisation.id}:${user.id}`, label: person ? `${person} \u00b7 ${org}` : org, tenants: [{ id: organisation.id, name: org }] };
		},

		manageLink() {
			return ["Sentry authorized applications", "https://sentry.io/settings/account/api/authorizations/"];
		},

		async discover(client, _kind, { query, cursor }) {
			const page = await client.projects({ query, after: cursor });
			return { items: page.items.map((project) => ({ id: project.id, name: projectName(project) })), nextCursor: page.next };
		},

		async describe(client, _kind, ids) {
			// Each id once, in its first place.
			const wanted = [...new Set(ids)].filter((id) => ID.test(id)).slice(0, MAX_DESCRIBE);
			const names = await gathered(wanted, CONCURRENCY, async (projectId) => {
				try {
					return projectName(await client.project(projectId));
				} catch (error) {
					if (unseen(error)) return null;
					throw error;
				}
			});
			// A Map, then Object.fromEntries: an id is a key of its own whatever it is.
			const found = new Map<string, string>();
			wanted.forEach((projectId, index) => {
				const name = names[index];
				if (name !== null && name !== undefined) found.set(projectId, name);
			});
			return Object.fromEntries(found);
		},
	};
}
