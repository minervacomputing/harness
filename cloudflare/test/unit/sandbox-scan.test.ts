// The scan's policy over `find`'s records (src/sandbox/scan.ts), without a container: which names are
// refused and why, how a skipped path is shown, the warnings' order and cap, empty directories, strict
// parsing of a record, and when the index vouches for a hash. The same against the real image is in
// test/docker/folder.test.ts.

import { describe, expect, test } from "vitest";
import { displayPath, indexEntry, type IndexEntry, type Kept, type Listed, Listing, mtimeOf, parseRecord, refusal, vouches } from "../../src/sandbox/scan.ts";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function listed(path: string | Uint8Array, overrides: Partial<Listed> = {}): Listed {
	return {
		readable: true,
		type: "f",
		size: 1,
		mtimeNs: 1_700_000_000_000_000_000n,
		ctimeNs: 1_700_000_000_000_000_000n,
		ino: "7",
		dev: "8",
		mode: 0o644,
		path: typeof path === "string" ? bytes(path) : path,
		...overrides,
	};
}

describe("the policy for a path", () => {
	test("keeps valid paths and refuses names by the manifest's rules, the first refused name deciding", () => {
		const deep = Array.from({ length: 32 }, () => "d").join("/");
		expect(refusal(bytes("a/b.txt"))).toBeNull();
		expect(refusal(bytes(deep))).toBeNull();
		expect(refusal(bytes(`${deep}/x`))).toEqual({ reason: "too_deep", below: false });
		expect(refusal(bytes("tab\there"))).toEqual({ reason: "invalid_name", below: false });
		expect(refusal(bytes("next\u0085line"))).toEqual({ reason: "invalid_name", below: false });
		expect(refusal(bytes("cafe\u0301"))).toEqual({ reason: "invalid_name", below: false });
		expect(refusal(Uint8Array.of(0x66, 0xff))).toEqual({ reason: "invalid_name", below: false });
		expect(refusal(bytes("x".repeat(256)))).toEqual({ reason: "too_long", below: false });
		expect(refusal(bytes("é".repeat(127)))).toBeNull();
		expect(refusal(bytes("é".repeat(128)))).toEqual({ reason: "too_long", below: false });
		const long = Array.from({ length: 4 }, () => "d".repeat(250)).join("/");
		expect(refusal(bytes(`${long}/${"x".repeat(20)}`))).toBeNull();
		expect(refusal(bytes(`${long}/${"x".repeat(21)}`))).toEqual({ reason: "too_long", below: false });
		// A byte-order mark is part of the name, and valid.
		expect(refusal(bytes("\ufeffbom.txt"))).toBeNull();
		for (const path of ["", ".", "..", "a/./b", "del\u007f", "/a"]) expect(refusal(bytes(path)), path).toMatchObject({ reason: "invalid_name" });
		expect(refusal(bytes("a//b"))).toEqual({ reason: "invalid_name", below: true });
	});

	test("says when the refused name lies above the path's last", () => {
		expect(refusal(Uint8Array.of(0x61, 0xff, 0x2f, 0x62))).toEqual({ reason: "invalid_name", below: true });
		expect(refusal(bytes("cafe\u0301/inner"))).toEqual({ reason: "invalid_name", below: true });
	});
});

describe("a skipped path as shown", () => {
	test("invalid bytes and control characters become U+FFFD; a byte-order mark stays", () => {
		expect(displayPath(Uint8Array.of(0x66, 0xff))).toBe("f\ufffd");
		expect(displayPath(bytes("tab\there\u0085"))).toBe("tab\ufffdhere\ufffd");
		expect(displayPath(bytes("\ufeffbom"))).toBe("\ufeffbom");
		expect(displayPath(Uint8Array.of(0xe2, 0x82, 0x61))).toBe("\ufffda");
	});

	test("is cut to 1,023 units and an ellipsis, never inside a surrogate pair", () => {
		expect(displayPath(bytes("x".repeat(1024)))).toBe("x".repeat(1024));
		expect(displayPath(bytes("x".repeat(1025)))).toBe(`${"x".repeat(1023)}…`);
		const shown = displayPath(bytes(`${"x".repeat(1022)}😀😀`));
		expect(shown).toBe(`${"x".repeat(1022)}…`);
		expect(shown.isWellFormed()).toBe(true);
	});
});

describe("a listing", () => {
	test("keeps 100 warnings, the first by path bytes, and counts them all", () => {
		const listing = new Listing();
		for (let i = 119; i >= 0; i--) listing.add(listed(`link${String(i).padStart(3, "0")}`, { type: "l" }));
		const warnings = listing.warnings;
		expect(warnings.total).toBe(120);
		expect(warnings.items).toHaveLength(100);
		expect(warnings.items[0]).toEqual({ path: "link000", reason: "symlink" });
		expect(warnings.items[99]).toEqual({ path: "link099", reason: "symlink" });
	});

	test("orders warnings by bytes, so by code point, and says why each entry was left out", () => {
		const listing = new Listing();
		listing.add(listed("😀", { type: "p" }));
		listing.add(listed("\uffff", { type: "s" }));
		listing.add(listed("locked", { type: "d", readable: false }));
		listing.add(listed("closed.txt", { readable: false }));
		listing.add(listed("tab\there"));
		listing.add(listed(Uint8Array.of(0x61, 0xff, 0x2f, 0x62)));
		listing.add(listed(Uint8Array.of(0x61, 0xff), { type: "d" }));
		expect(listing.warnings).toEqual({
			total: 6,
			items: [
				{ path: "a\ufffd", reason: "invalid_name" },
				{ path: "closed.txt", reason: "unreadable" },
				{ path: "locked", reason: "unreadable" },
				{ path: "tab\ufffdhere", reason: "invalid_name" },
				{ path: "\uffff", reason: "special" },
				{ path: "😀", reason: "special" },
			],
		});
		expect(listing.files).toEqual([]);
	});

	test("orders files by path bytes: UTF-8's order, not UTF-16's", () => {
		const listing = new Listing();
		for (const path of ["\ud83d\ude00", "\uffff", "\ufeffbom.txt", "\u00e9.txt", "b.txt", "Z.sh"]) listing.add(listed(path));
		expect(listing.sorted().map((file) => file.path)).toEqual(["Z.sh", "b.txt", "\u00e9.txt", "\ufeffbom.txt", "\uffff", "\ud83d\ude00"]);
	});

	test("does not count what lies inside a directory refused for its name", () => {
		const listing = new Listing();
		expect(listing.add(listed(Uint8Array.of(0x61, 0xff), { type: "d" }))).toBe(true);
		expect(listing.add(listed(Uint8Array.of(0x61, 0xff, 0x2f, 0x62)))).toBe(false);
		expect(listing.add(listed("link", { type: "l" }))).toBe(true);
		expect(listing.add(listed("kept"))).toBe(true);
		expect(listing.warnings.total).toBe(2);
	});

	test("keeps regular files with their mode from the owner's execute bit, and lists only empty directories", () => {
		const listing = new Listing();
		for (const dir of ["a", "a/sub", "empty", "b", "b/only-link"]) listing.add(listed(dir, { type: "d" }));
		listing.add(listed("a/x.txt", { mode: 0o700 }));
		listing.add(listed("b/only-link/l", { type: "l" }));
		listing.add(listed("z.txt", { mode: 0o604 }));
		expect(listing.sorted().map((file) => [file.path, file.mode])).toEqual([
			["a/x.txt", 0o755],
			["z.txt", 0o644],
		]);
		expect(listing.emptyDirs()).toEqual(["a/sub", "b/only-link", "empty"]);
	});
});

describe("a record", () => {
	const record = (...fields: string[]) => fields.map((field) => bytes(field));
	const fields = ["r", "f", "12", "1700000000.5000000000", "1700000001.0000000010", "99", "2049", "755", "/workspace/a b"];

	test("is read exactly, its times to the nanosecond", () => {
		expect(parseRecord(record(...fields))).toEqual({
			readable: true,
			type: "f",
			size: 12,
			mtimeNs: 1_700_000_000_500_000_000n,
			ctimeNs: 1_700_000_001_000_000_001n,
			ino: "99",
			dev: "2049",
			mode: 0o755,
			path: bytes("a b"),
		});
		expect(parseRecord(record(...fields.slice(0, 3), "-1.5000000000", ...fields.slice(4)))?.mtimeNs).toBe(-1_500_000_000n);
	});

	test("is refused when any field is not what find prints", () => {
		const replace = (index: number, value: string) => record(...fields.map((field, at) => (at === index ? value : field)));
		for (const [index, value] of [
			[0, "x"],
			[1, "ff"],
			[2, "1e3"],
			[2, "99999999999999999"],
			[3, "1.2.3"],
			[4, ""],
			[5, "-1"],
			[6, "x"],
			[7, "8"],
			[8, "/workspace/"],
			[8, "/workspaces/a"],
			[8, "a"],
		] as const) {
			expect(parseRecord(replace(index, value)), `${index}: ${value}`).toBeNull();
		}
		expect(parseRecord(record(...fields.slice(0, 8)))).toBeNull();
	});
});

describe("the index", () => {
	const file: Kept = { path: "a", key: bytes("a"), size: 1, mtimeNs: 5_000_000_000n, ctimeNs: 6_000_000_000n, ino: "1", dev: "2", mode: 0o644 };
	const entry: IndexEntry = { size: 1, mtimeNs: 5_000_000_000n, ctimeNs: 6_000_000_000n, ino: "1", dev: "2", sha256: "0".repeat(64), mtime: 5000, racy: false };

	test("vouches for a hash only while settled and every stat field is unchanged", () => {
		expect(vouches(entry, file)).toBe(true);
		expect(vouches(undefined, file)).toBe(false);
		expect(vouches({ ...entry, racy: true }, file)).toBe(false);
		for (const change of [{ size: 2 }, { mtimeNs: 5_000_000_001n }, { ctimeNs: 6_000_000_001n }, { ino: "3" }, { dev: "4" }]) {
			expect(vouches(entry, { ...file, ...change })).toBe(false);
		}
	});

	test("marks a file racy when its ctime is within a second of the scan, and keeps a manifest mtime its mtime still matches", () => {
		expect(indexEntry(file, "a".repeat(64), undefined, 7_000_000_000n)).toMatchObject({ racy: true, mtime: 5000, sha256: "a".repeat(64) });
		expect(indexEntry(file, "a".repeat(64), undefined, 7_000_000_001n).racy).toBe(false);
		expect(indexEntry(file, "a".repeat(64), { ...entry, mtime: 5001 }, 9_000_000_000n).mtime).toBe(5001);
		expect(indexEntry({ ...file, mtimeNs: 5_002_000_000n }, "a".repeat(64), { ...entry, mtime: 5001 }, 9_000_000_000n).mtime).toBe(5002);
	});

	test("an mtime in milliseconds stays within what a manifest holds", () => {
		expect(mtimeOf(1_700_000_000_123_999_999n)).toBe(1_700_000_000_123);
		expect(mtimeOf(-1n)).toBe(0);
		expect(mtimeOf(10n ** 30n)).toBe(253_402_300_799_999);
	});
});
