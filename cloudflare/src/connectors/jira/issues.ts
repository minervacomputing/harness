// What Jira's operations share: sites, project and issue
// names, and where issues sit.

import { z } from "zod";
import { type Binding, OperationError, denied } from "../../gateway/connector.ts";
import type { Resource } from "../../gateway/policy.ts";
import { CLOUD_ID, type Site } from "../atlassian/index.ts";
import type { Issue, JiraClient, Project } from "./client.ts";

export const PROJECT = "project";
const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN"]);

/** ASCII digits only. */
export const ID = /^\d{1,18}$/u;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-\d{1,9}$/u;

export const SITE_ID_DESCRIPTION = "The site's id, from list_projects. Needed only when the connection reaches several sites.";

/** A site's cloud id, in lower case. */
export function siteId() {
	return z.string().trim().min(36).max(36)
		.describe(SITE_ID_DESCRIPTION)
		.refine((value) => CLOUD_ID.test(value.toLowerCase()), "must be a site id from list_projects")
		.transform((value) => value.toLowerCase());
}

/** A project key (upper-cased) or id. */
export function projectName() {
	return z.string().trim().min(1).max(255)
		.describe('A project key such as "ENG", or a project id.')
		.refine((value) => ID.test(value) || PROJECT_KEY.test(value.toUpperCase()), 'must be a project key such as "ENG", or a project id')
		.transform((value) => value.toUpperCase());
}

/** An issue key (upper-cased) or id. */
export function issueName() {
	return z.string().trim().min(1).max(266)
		.describe('An issue key such as "ENG-123", or an issue id.')
		.refine((value) => ID.test(value) || ISSUE_KEY.test(value.toUpperCase()), 'must be an issue key such as "ENG-123", or an issue id')
		.transform((value) => value.toUpperCase());
}

export function unseen(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

export function issueMoved(): OperationError {
	return new OperationError("ISSUE_MOVED", "This issue moved in Jira while Minerva was using it, or access was lost. Try again.");
}

export function projectId(site: Site, project: string): string {
	return `${site.id}/${project}`;
}

/** The resource of a project Jira named. A malformed id fails rather than being guessed. */
export function projectResource(binding: Binding, site: Site, project: string | null | undefined): Resource {
	if (project === null || project === undefined || !ID.test(project)) throw (binding.client as JiraClient).unexpected();
	return binding.resource(PROJECT, projectId(site, project), [site.id]);
}

/** The hosts of the connection's sites, whose addresses text hides as links to Atlassian. */
export function hosts(sites: readonly Site[]): string[] {
	return sites.map((site) => site.host).filter((host): host is string => Boolean(host));
}

/** The project a call names. One the account cannot see is refused like one without a grant. */
export async function resolveProject(binding: Binding, siteId: string | null, name: string): Promise<[Site, Resource, Project]> {
	const client = binding.client as JiraClient;
	const site = await client.site(siteId);
	let project: Project;
	try {
		project = await client.project(site.id, name);
	} catch (error) {
		if (unseen(error)) throw denied();
		throw error;
	}
	// A former key leads to the project too; grants are on its id, so that spelling changes nothing.
	return [site, projectResource(binding, site, project.id), project];
}

/**
 * The issue a call names: its site, its project's resource and its id. Jira also answers to an issue's
 * former keys; the project is the one the issue is in now. One the account cannot see is refused like one
 * without a grant.
 */
export async function resolveIssue(binding: Binding, siteId: string | null, name: string): Promise<[Site, Resource, string]> {
	const client = binding.client as JiraClient;
	const site = await client.site(siteId);
	let issue: Issue;
	try {
		issue = await client.issue(site.id, name, "project");
	} catch (error) {
		if (unseen(error)) throw denied();
		throw error;
	}
	if (!ID.test(issue.id) || issue.fields.project === null) throw client.unexpected();
	return [site, projectResource(binding, site, issue.fields.project.id), issue.id];
}

/** The issue read again by id, refused unless it is still in the project it was authorized in. */
export async function confirmIssue(binding: Binding, site: Site, resource: Resource, issueId: string, fields: string): Promise<Issue> {
	const client = binding.client as JiraClient;
	let issue: Issue;
	try {
		issue = await client.issue(site.id, issueId, fields.split(",").includes("project") ? fields : `${fields},project`);
	} catch (error) {
		if (unseen(error)) throw issueMoved();
		throw error;
	}
	const project = issue.fields.project;
	if (issue.id !== issueId || project === null || projectId(site, project.id) !== resource.id) throw issueMoved();
	return issue;
}

export function link(site: Site, key: string): string | null {
	return site.host ? `https://${site.host}/browse/${key}` : null;
}
