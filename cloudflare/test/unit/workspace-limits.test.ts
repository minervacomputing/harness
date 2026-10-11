// The Workspace's text helpers against Python's formatting: `format(x, "g")`, `size_text`, `f"{n:,}"` and
// the attachment limits' messages (files 10; uploads.py `_over`), and the schema steps over node:sqlite.

import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/workspace/schema.ts";
import { formatG, overFolder, pages, sizeText, thousands, tooManyAttachments } from "../../src/workspace/limits.ts";
import { migrate } from "../../src/lib/sql.ts";
import { database, nodeSql } from "./workspace-support.ts";

describe("Python's formatting", () => {
	test("format(x, 'g'): six significant digits, trailing zeros dropped, exponents outside [-4, 6)", () => {
		const cases: [number, string][] = [
			[256, "256"],
			[0.5, "0.5"],
			[1.5, "1.5"],
			[286.102294921875, "286.102"],
			[100000, "100000"],
			[999999, "999999"],
			[999999.5, "1e+06"],
			[1234567, "1.23457e+06"],
			[0.0001, "0.0001"],
			[0.00001234, "1.234e-05"],
			[2, "2"],
			[0, "0"],
			[-3.25, "-3.25"],
		];
		for (const [value, text] of cases) expect(formatG(value), String(value)).toBe(text);
	});

	test("size_text and the thousands separator", () => {
		expect(sizeText(268_435_456)).toBe("256 MB");
		expect(sizeText(2 ** 30)).toBe("1 GB");
		expect(sizeText(1.5 * 2 ** 30)).toBe("1.5 GB");
		expect(sizeText(50 * 2 ** 20)).toBe("50 MB");
		expect(thousands(10_000)).toBe("10,000");
		expect(thousands(999)).toBe("999");
		expect(thousands(1_234_567)).toBe("1,234,567");
	});

	test("the messages", () => {
		expect(tooManyAttachments(10)).toBe("Attach at most 10 files to a message.");
		expect(overFolder("folder_entries", 10_000, 268_435_456)).toBe("These files would put more than 10,000 files and folders in this conversation's folder.");
		expect(overFolder("folder_bytes", 10_000, 268_435_456)).toBe("These files would make this conversation's folder larger than 256 MB.");
		expect([pages(0), pages(1), pages(4096), pages(4097)]).toEqual([0, 4096, 4096, 8192]);
	});
});

describe("schema steps", () => {
	test("apply once, in order, in lib/sqlite.ts's table", () => {
		const sql = nodeSql(database());
		expect(migrate(sql, MIGRATIONS, 1)).toEqual([1]);
		expect(migrate(sql, MIGRATIONS, 2)).toEqual([]);
		expect(sql.exec("SELECT id, applied_at FROM _migrations")).toEqual([{ id: 1, applied_at: 1 }]);
		// A failing step leaves nothing behind.
		expect(() => migrate(sql, [...MIGRATIONS, { id: 2, sql: "CREATE TABLE u (a); CREATE TABLE workspace (b)" }], 3)).toThrow();
		expect(sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u'")).toEqual([{ n: 0 }]);
	});
});
