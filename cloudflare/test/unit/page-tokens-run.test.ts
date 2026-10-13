// gateway/page-tokens.ts on real SQLite: opaque, run-bound, query-bound tokens, at most 200 per run, the
// column limits in UTF-16 code units; and the query hash over the normalized fields.

import { describe, expect, test } from "vitest";
import { MAX_PAGE_TOKENS, PageTokens, queryHash } from "../../src/gateway/page-tokens.ts";
import { ledgerSql } from "./sqlite.ts";

const RUN = "0199a000-0000-7000-8000-0000000000c1";
const OTHER = "0199a000-0000-7000-8000-0000000000c2";

describe("page tokens", () => {
	test("a token is 24 URL-safe characters and resolves only for its run, tool and query", async () => {
		const tokens = new PageTokens(ledgerSql());
		const hash = await queryHash({ project_id: "work", limit: 2, cursor: null });
		const token = tokens.issue(RUN, "todoist_list_tasks", hash, "2") as string;
		expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
		expect(tokens.resolve(RUN, token, "todoist_list_tasks", hash)).toBe("2");
		expect(tokens.resolve(OTHER, token, "todoist_list_tasks", hash)).toBeNull();
		expect(tokens.resolve(RUN, token, "todoist2_list_tasks", hash)).toBeNull();
		expect(tokens.resolve(RUN, token, "todoist_list_tasks", await queryHash({ project_id: "private", limit: 2, cursor: null }))).toBeNull();
		expect(tokens.resolve(RUN, "2", "todoist_list_tasks", hash)).toBeNull();
	});

	test("the query hash leaves out only the cursor, over keys sorted at every depth", async () => {
		const hash = await queryHash({ project_id: "work", limit: 2, cursor: "token-1", filter: { b: 1, a: 2 } });
		expect(await queryHash({ filter: { a: 2, b: 1 }, cursor: "token-2", limit: 2, project_id: "work" })).toBe(hash);
		expect(await queryHash({ project_id: "work", limit: 3, cursor: "token-1", filter: { b: 1, a: 2 } })).not.toBe(hash);
		// A default the model left out is part of the normalized fields, so it hashes as if sent.
		expect(await queryHash({ project_id: "work", limit: 30 })).not.toBe(await queryHash({ project_id: "work" }));
	});

	test("a run holds at most 200; tokens are never deleted while it runs", () => {
		const tokens = new PageTokens(ledgerSql());
		const issued = new Set<string>();
		for (let i = 0; i < MAX_PAGE_TOKENS; i++) issued.add(tokens.issue(RUN, "t", "h", String(i)) as string);
		expect(issued.size).toBe(200);
		expect(tokens.issue(RUN, "t", "h", "201")).toBeNull();
		expect(tokens.count(RUN)).toBe(200);
		expect(tokens.issue(OTHER, "t", "h", "1")).not.toBeNull();
		tokens.forget(RUN);
		expect(tokens.count(RUN)).toBe(0);
	});

	test("a cursor or tool name longer than a page token holds refuses", () => {
		const tokens = new PageTokens(ledgerSql());
		expect(tokens.issue(RUN, "t", "h", "x".repeat(1000))).not.toBeNull();
		// Counted in UTF-16 units: an emoji is two.
		expect(tokens.issue(RUN, "t", "h", "\u{1f600}".repeat(500))).not.toBeNull();
		expect(() => tokens.issue(RUN, "t", "h", "\u{1f600}".repeat(501))).toThrow(/1000 characters/);
		expect(() => tokens.issue(RUN, "t", "h", "x".repeat(1001))).toThrow(/1000 characters/);
		expect(() => tokens.issue(RUN, "x".repeat(129), "h", "1")).toThrow(/128 characters/);
	});

	test("a run at its limit is told so whatever the cursor, as the count comes first", () => {
		const tokens = new PageTokens(ledgerSql());
		for (let i = 0; i < MAX_PAGE_TOKENS; i++) tokens.issue(RUN, "t", "h", String(i));
		expect(tokens.issue(RUN, "t", "h", "x".repeat(1001))).toBeNull();
	});
});
