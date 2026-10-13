// What Linear's operations share: team and issue names, where teams sit, and page tokens.

import { z } from "zod";
import type { Binding } from "../../contracts/connectors.ts";
import type { Resource } from "../../contracts/policy.ts";
import { OperationError, denied } from "../../gateway/connector.ts";
import { type LinearClient, MAX_TEAM_DEPTH, type PageInfo, type State, type Team, type TeamRef } from "./client.ts";
import { IDENTIFIER } from "./markdown.ts";

export const TEAM = "team";
export const CLOSED: readonly string[] = ["completed", "canceled"];
export const HIDDEN: ReadonlySet<string> = new Set(["NOT_FOUND", "PROVIDER_FORBIDDEN", "PROVIDER_REJECTED"]);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEAM_KEY = /^[A-Z0-9]{1,10}$/;
const CURSOR = /^[\x21-\x7e]{1,500}$/;

export const TEAM_NAME = 'must be a team key such as "ENG", or a team id';
export const ISSUE_NAME = 'must be an issue identifier such as "ENG-123", or an issue id';

/** A team key ("ENG", uppercased) or a team id (lowercased), else null. */
export function teamName(value: string): string | null {
	if (UUID.test(value.toLowerCase())) return value.toLowerCase();
	if (TEAM_KEY.test(value.toUpperCase())) return value.toUpperCase();
	return null;
}

/** An issue identifier ("ENG-123", uppercased) or an issue id (lowercased), else null. */
export function issueName(value: string): string | null {
	if (UUID.test(value.toLowerCase())) return value.toLowerCase();
	if (IDENTIFIER.test(value)) return value.toUpperCase();
	return null;
}

/** `TeamName`: a team key such as "ENG", or a team id. */
export function TeamName() {
	return z.string().trim().min(1).max(36)
		.describe('A team key such as "ENG", or a team id.')
		.refine((value) => teamName(value) !== null, TEAM_NAME)
		.transform((value) => teamName(value) as string);
}

/** `IssueName`: an issue identifier such as "ENG-123", or an issue id. */
export function IssueName() {
	return z.string().trim().min(1).max(36)
		.describe('An issue identifier such as "ENG-123", or an issue id.')
		.refine((value) => issueName(value) !== null, ISSUE_NAME)
		.transform((value) => issueName(value) as string);
}

/** `Cursor`: a page token, at most 500 characters. */
export function Cursor() {
	return z.string().trim().max(500).nullable().default(null);
}

export type Cursor = z.output<ReturnType<typeof Cursor>>;

export function issueMoved(): OperationError {
	return new OperationError("ISSUE_MOVED", "This issue or its team moved in Linear while Minerva was using it. Try again.");
}

export function teamMoved(): OperationError {
	return new OperationError("TEAM_MOVED", "This team moved in Linear while Minerva was using it. Try again.");
}

export function clientOf(binding: Binding): LinearClient {
	return binding.client as LinearClient;
}

/** The team's parent teams, nearest first, and whether the chain may go on beyond them. */
export function ancestry(team: TeamRef): [within: string[], partial: boolean] {
	const within: string[] = [];
	const seen = new Set([team.id.toLowerCase()]);
	let current = team.parent;
	while (current !== null) {
		const parentId = current.id.toLowerCase();
		if (seen.has(parentId) || !UUID.test(parentId) || within.length >= MAX_TEAM_DEPTH) return [within, true];
		seen.add(parentId);
		within.push(parentId);
		current = current.parent;
	}
	return [within, false];
}

export function teamResource(binding: Binding, team: TeamRef): Resource {
	const teamId = team.id.toLowerCase();
	if (!UUID.test(teamId)) throw new OperationError("PROVIDER_FAILED", "Linear returned an unexpected response.");
	const [within, partial] = ancestry(team);
	return binding.resource(TEAM, teamId, within, partial);
}

function sameResource(a: Resource, b: Resource): boolean {
	return (
		a.connectionId === b.connectionId &&
		a.kind === b.kind &&
		a.id === b.id &&
		a.partial === b.partial &&
		a.within.length === b.within.length &&
		a.within.every((id, index) => id === b.within[index])
	);
}

export function samePlace(binding: Binding, resource: Resource, team: TeamRef): boolean {
	return sameResource(teamResource(binding, team), resource);
}

/** An error by which Linear hides what the account cannot see: not found, forbidden or rejected. */
export function hidden(error: unknown): boolean {
	return error instanceof OperationError && HIDDEN.has(error.code);
}

/**
 * The team a call names, as the resource that is authorized. Teams the account cannot see are refused
 * like teams without a grant.
 */
export async function resolveTeam(binding: Binding, name: string): Promise<Resource> {
	const client = clientOf(binding);
	let team: Team | null;
	try {
		if (UUID.test(name)) {
			team = await client.team(name);
			if (team.id.toLowerCase() !== name) team = null;
		} else {
			const found = (await client.teamByKey(name)).filter((candidate) => candidate.key.toUpperCase() === name);
			team = found.length === 1 ? (found[0] as Team) : null;
		}
	} catch (error) {
		if (hidden(error)) throw denied();
		throw error;
	}
	if (team === null) throw denied();
	return teamResource(binding, team);
}

/** The issue a call names (its id) and its team, which is what is authorized. */
export async function resolveIssue(binding: Binding, name: string): Promise<[issueId: string, resource: Resource]> {
	let place;
	try {
		place = await clientOf(binding).issuePlace(name);
	} catch (error) {
		if (hidden(error)) throw denied();
		throw error;
	}
	const issueId = place.id.toLowerCase();
	if (!UUID.test(issueId) || (UUID.test(name) && issueId !== name)) throw denied();
	return [issueId, teamResource(binding, place.team)];
}

export async function confirmTeam(binding: Binding, resource: Resource): Promise<Team> {
	let team: Team;
	try {
		team = await clientOf(binding).team(resource.id);
	} catch (error) {
		if (hidden(error)) throw teamMoved();
		throw error;
	}
	if (!samePlace(binding, resource, team)) throw teamMoved();
	return team;
}

/** The issue's identifier, refused if the issue or its team moved since `resource` was authorized. */
export async function confirmIssue(binding: Binding, issueId: string, resource: Resource): Promise<string> {
	let place;
	try {
		place = await clientOf(binding).issuePlace(issueId);
	} catch (error) {
		if (hidden(error)) throw issueMoved();
		throw error;
	}
	if (place.id.toLowerCase() !== issueId || !samePlace(binding, resource, place.team)) throw issueMoved();
	return place.identifier;
}

export function checkedCursor(cursor: string | null): string | null {
	if (cursor !== null && !CURSOR.test(cursor)) throw new OperationError("INVALID_CURSOR", "This page token is invalid.");
	return cursor;
}

export function nextCursor(page: PageInfo): string | null {
	if (!page.hasNextPage || !page.endCursor) return null;
	if (!CURSOR.test(page.endCursor)) throw new OperationError("PROVIDER_LIMIT", "Linear returned a page token Minerva cannot use.");
	return page.endCursor;
}

export function stateData(state: State | null): { name: string; type: string } | null {
	return state !== null ? { name: state.name, type: state.type } : null;
}
