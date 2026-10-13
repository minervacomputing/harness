// Manifests: validation and its messages, the stored form and its digest, folder sizes, warnings and what a
// turn changed.

import { describe, expect, test } from "vitest";
import type { StoredEntries } from "../../src/contracts/files.ts";
import { MAX_MTIME, QuotaExceeded, folderBytes } from "../../src/files/limits.ts";
import {
	InvalidManifest,
	digestOf,
	directories,
	entriesBytes,
	entryCountOf,
	filesOf,
	folderChanges,
	isValidPath,
	parseManifest,
	parseWarnings,
	rootNames,
	sameManifest,
	storedEntries,
	wireOf,
} from "../../src/files/manifest.ts";
import { sha256HexSync } from "../../src/files/sha256.ts";
import { hex, utf8 } from "../../src/lib/bytes.ts";
import { canonicalJson } from "../../src/lib/canonical.ts";
import { parseJson } from "../../src/lib/json.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

function file(path: unknown, sha256: unknown = A, mode: unknown = 0o644, mtime: unknown = 0) {
	return { path, sha256, mode, mtime };
}

describe("parsing a manifest", () => {
	test("a manifest counts every directory, including implied ones", () => {
		const manifest = parseManifest({ files: [file("docs/a/x.txt"), file("docs/b.txt", B)], dirs: ["empty"] }, 10);
		expect([...manifest.files.keys()]).toEqual(["docs/a/x.txt", "docs/b.txt"]);
		expect(manifest.dirs).toEqual(["empty"]);
		// Two files, docs, docs/a, empty.
		expect(manifest.entryCount).toBe(5);
		expect(new Set([...manifest.files.values()].map((entry) => entry.sha256))).toEqual(new Set([A, B]));
	});

	test.each([
		"/abs",
		"a//b",
		"a/",
		"./a",
		"a/../b",
		"..",
		"",
		"a\x00b",
		"a\nb",
		"é", // not NFC
		"\udcff", // not encodable as UTF-8
		"x".repeat(256),
		Array(33).fill("d").join("/"),
		Array(6).fill("x".repeat(200)).join("/"), // over 1,024 bytes
		7,
	])("a path must be relative, normalised and bounded: %j", (path) => {
		expect(() => parseManifest({ files: [file(path)], dirs: [] }, 10)).toThrow(InvalidManifest);
		expect(isValidPath(path)).toBe(false);
	});

	test("the deepest and longest paths allowed pass", () => {
		const deep = Array(32).fill("d").join("/");
		const longName = "é".repeat(127); // 254 bytes
		parseManifest({ files: [file(deep), file(longName)], dirs: [] }, 100);
		expect(isValidPath(deep) && isValidPath(longName)).toBe(true);
	});

	test.each([
		[[]],
		[{ files: [] }],
		[{ files: [], dirs: [], extra: 1 }],
		[{ files: {}, dirs: [] }],
		[{ files: [{ ...file("a"), size: 1 }], dirs: [] }],
		[{ files: [file("a", "A".repeat(64))], dirs: [] }],
		[{ files: [file("a", "a".repeat(63))], dirs: [] }],
		[{ files: [file("a", A, 0o777)], dirs: [] }],
		[{ files: [file("a", A, true)], dirs: [] }],
		[{ files: [file("a", A, 0o644, -1)], dirs: [] }],
		[{ files: [file("a", A, 0o644, 1.5)], dirs: [] }],
		[{ files: [file("a", A, 0o644, MAX_MTIME + 1)], dirs: [] }],
		[{ files: [file("a"), file("a", B)], dirs: [] }],
		[{ files: [file("a")], dirs: ["a"] }],
		[{ files: [], dirs: ["a", "a"] }],
		[{ files: [file("a"), file("a/b")], dirs: [] }],
		[{ files: [file("a/b")], dirs: ["a"] }],
	])("a malformed manifest is refused: %j", (data) => {
		expect(() => parseManifest(data, 10)).toThrow(InvalidManifest);
	});

	test("the entry limit counts implied directories", () => {
		const data = { files: [file("a/b/c/d.txt")], dirs: [] };
		expect(parseManifest(data, 4).entryCount).toBe(4);
		expect(() => parseManifest(data, 3)).toThrow(QuotaExceeded);
		try {
			parseManifest(data, 3);
		} catch (error) {
			expect((error as QuotaExceeded).limit).toBe("folder_entries");
			expect((error as QuotaExceeded).message).toBe("The folder_entries limit would be exceeded.");
		}
	});

	test("refusals name the path, quoted as JSON", () => {
		const refusal = (data: unknown) => {
			try {
				parseManifest(data, 10);
			} catch (error) {
				return (error as Error).message;
			}
			return null;
		};
		const one = (path: unknown, ...rest: unknown[]) => refusal({ files: [file(path, ...rest)], dirs: [] });
		expect(refusal([])).toBe('A manifest is an object with exactly "files" and "dirs".');
		expect(refusal({ files: {}, dirs: [] })).toBe('"files" and "dirs" are lists.');
		expect(refusal({ files: [{ ...file("a"), size: 1 }], dirs: [] })).toBe("A file entry has exactly path, sha256, mode and mtime.");
		expect(one(7)).toBe("A path is a string.");
		expect(one("\udcff")).toBe("A path is valid UTF-8.");
		expect(one("x/".repeat(600))).toBe("A path has at most 1024 bytes.");
		expect(one("a/../b")).toBe('"a/../b" is not a relative path without empty, . or .. segments.');
		expect(one("a\u0085b")).toBe('"a\u0085b" contains a control character.');
		expect(one("a\nb")).toBe('"a\\nb" contains a control character.');
		expect(one("e\u0301")).toBe('"e\u0301" is not in NFC.');
		expect(one(Array(33).fill("d").join("/"))).toBe(`${JSON.stringify(Array(33).fill("d").join("/"))} is more than 32 levels deep.`);
		expect(one("\u00e9".repeat(128))).toBe(`${JSON.stringify("\u00e9".repeat(128))} has a name longer than 255 bytes.`);
		expect(one("a'\"b", "A".repeat(64))).toBe('"a\'\\"b": sha256 is 64 lowercase hex digits.');
		expect(one("a", A, 0o777)).toBe('"a": mode is 0644 or 0755.');
		expect(one("a", A, 0o644, -1)).toBe('"a": mtime is an integer number of milliseconds within range.');
		expect(refusal({ files: [file("a"), file("a", B)], dirs: [] })).toBe('"a" is listed twice.');
		expect(refusal({ files: [file("a"), file("a/b")], dirs: [] })).toBe('"a" is both a file and a directory.');
		expect(refusal({ files: [file("a/b")], dirs: ["a"] })).toBe('"a" is listed as an empty directory but has entries.');
	});

	test("names with invisible or unusual characters are paths like any other", () => {
		const paths = ["a\u202eb", "\ufeffbom", "a b", " ", "\u{e0001}", "a\\b", "a'\"b", "\u{1f600}/\u{1f600}"];
		const manifest = parseManifest({ files: paths.map((path) => file(path)), dirs: [] }, 100);
		expect([...manifest.files.keys()]).toEqual(paths);
		expect(manifest.dirs).toEqual([]);
	});

	test("an oversized manifest is refused before its paths are checked", () => {
		expect(() => parseManifest({ files: Array(11).fill({ path: null }), dirs: [] }, 10)).toThrow(QuotaExceeded);
	});

	test("the digest ignores order and the size rounds up to pages", () => {
		const first = parseManifest({ files: [file("a"), file("b", B)], dirs: ["z", "y"] }, 10);
		const second = parseManifest({ files: [file("b", B), file("a")], dirs: ["y", "z"] }, 10);
		const sizes = new Map([
			[A, 1],
			[B, 4097],
		]);
		const entries = storedEntries(first, sizes);
		expect(entries).toEqual(storedEntries(second, sizes));
		expect(digestOf(entries)).toBe(digestOf(storedEntries(second, sizes)));
		// Over the label and the canonical JSON of the stored entries.
		expect(digestOf(entries)).toBe(sha256HexSync(utf8(`minerva:folder-version:${canonicalJson(entries)}`)));
		expect(entriesBytes(entries)).toBe(4096 + 8192);
		expect(entries.files.b).toEqual({ sha256: B, size: 4097, mode: 0o644, mtime: 0 });
		expect(folderBytes([0, 1, 4096, 4097])).toBe(0 + 4096 + 4096 + 8192);
	});

	test("a manifest at the entry limit is checked quickly", () => {
		// Each file in its own directory: about 10,000 entries, every one an implied directory or a file.
		const files = Array.from({ length: 4999 }, (_, i) => file(`d${i}/f`));
		const started = performance.now();
		expect(parseManifest({ files, dirs: [] }, 10_000).entryCount).toBe(9998);
		expect(performance.now() - started).toBeLessThan(200);
	});
});

describe("the stored form", () => {
	test("paths that are object keys in JavaScript stay own entries, in UTF-16 order", () => {
		const paths = ["__proto__", "constructor", "10", "9", "\u{1F600}", "", "Z"];
		const manifest = parseManifest({ files: paths.map((path) => file(path)), dirs: [] }, 100);
		const entries = storedEntries(manifest, new Map([[A, 3]]));
		expect(Object.hasOwn(entries.files, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(entries.files)).toBe(Object.prototype);
		// UTF-16 order puts an emoji (a surrogate pair) before U+E000, and "10" before "9".
		expect(filesOf(entries).map(([path]) => path)).toEqual(["10", "9", "Z", "__proto__", "constructor", "\u{1F600}", ""]);
		const text = canonicalJson(entries, { identity: true });
		const again = parseJson(text) as unknown as StoredEntries;
		expect(Object.hasOwn(again.files, "__proto__")).toBe(true);
		expect(digestOf(again)).toBe(digestOf(entries));
		expect(wireOf(again).files.map((entry) => entry.path)).toEqual(filesOf(entries).map(([path]) => path));
		expect(rootNames(again)).toEqual(new Set(paths));
	});

	test("entry counts and root names include implied and listed directories", () => {
		const manifest = parseManifest({ files: [file("a/b/c.txt"), file("x.txt")], dirs: ["d/e", "f"] }, 100);
		const entries = storedEntries(manifest, new Map([[A, 1]]));
		expect(entryCountOf(entries)).toBe(manifest.entryCount);
		expect(manifest.entryCount).toBe(2 + 2 + 2 + 1);
		expect(directories(entries)).toEqual(new Set(["a", "a/b", "d", "d/e", "f"]));
		expect(rootNames(entries)).toEqual(new Set(["a", "x.txt", "d", "f"]));
		expect(rootNames(null)).toEqual(new Set());
	});

	test("an identical manifest: the same hashes, modes and mtimes and the same empty directories; sizes are not compared", () => {
		const manifest = parseManifest({ files: [file("a", A, 0o644, 5)], dirs: ["e"] }, 10);
		const entries = storedEntries(manifest, new Map([[A, 3]]));
		expect(sameManifest({ ...entries, files: { a: { ...(entries.files.a as StoredEntries["files"][string]), size: 99 } } }, manifest)).toBe(true);
		expect(sameManifest(entries, parseManifest({ files: [file("a", A, 0o644, 6)], dirs: ["e"] }, 10))).toBe(false);
		expect(sameManifest(entries, parseManifest({ files: [file("a", A, 0o755, 5)], dirs: ["e"] }, 10))).toBe(false);
		expect(sameManifest(entries, parseManifest({ files: [file("a", A, 0o644, 5)], dirs: [] }, 10))).toBe(false);
		expect(sameManifest(entries, parseManifest({ files: [file("a", A, 0o644, 5), file("b")], dirs: ["e"] }, 10))).toBe(false);
		// With no version yet, only an empty manifest is the same.
		expect(sameManifest(null, parseManifest({ files: [], dirs: [] }, 10))).toBe(true);
		expect(sameManifest(null, parseManifest({ files: [], dirs: ["e"] }, 10))).toBe(false);
	});
});

describe("warnings", () => {
	const items = (n: number, reason = "symlink") => Array.from({ length: n }, () => ({ path: "a", reason }));

	test("the stored form: a total and at most 100 items, each a path and a known reason", () => {
		const all = ["invalid_name", "special", "symlink", "too_deep", "too_long", "unreadable"].map((reason, i) => ({ path: `p${i}`, reason }));
		expect(parseWarnings({ total: 6, items: all })).toEqual({ total: 6, items: all });
		expect(parseWarnings({ total: 0, items: [] })).toEqual({ total: 0, items: [] });
		expect(parseWarnings({ total: 2 ** 31 - 1, items: items(100) })).toEqual({ total: 2 ** 31 - 1, items: items(100) });
		// Invisible characters are kept as they are: the path is shown, never used.
		expect(parseWarnings({ total: 1, items: [{ path: "a\u202eb\ufeff", reason: "invalid_name" }] }).items[0]?.path).toBe("a\u202eb\ufeff");
		expect(parseWarnings({ total: 1, items: [{ path: "x".repeat(1024), reason: "too_long" }] }).items[0]?.path).toHaveLength(1024);
	});

	test.each([
		[[], 'Warnings are {"total", "items"}.'],
		[{ total: 0 }, 'Warnings are {"total", "items"}.'],
		[{ total: 0, items: [], more: 1 }, 'Warnings are {"total", "items"}.'],
		[{ total: 1, items: {} }, "Warnings list at most 100 items."],
		[{ total: 101, items: items(101) }, "Warnings list at most 100 items."],
		[{ total: true, items: [] }, "The warnings' total is not a count of their items."],
		[{ total: 1.5, items: [] }, "The warnings' total is not a count of their items."],
		[{ total: -1, items: [] }, "The warnings' total is not a count of their items."],
		[{ total: 0, items: items(1) }, "The warnings' total is not a count of their items."],
		[{ total: 2 ** 31, items: [] }, "The warnings' total is not a count of their items."],
		[{ total: 1, items: ["a"] }, 'A warning is {"path", "reason"}, with a known reason.'],
		[{ total: 1, items: items(1, "deleted") }, 'A warning is {"path", "reason"}, with a known reason.'],
		[{ total: 1, items: [{ path: "a", reason: "constructor" }] }, 'A warning is {"path", "reason"}, with a known reason.'],
		[{ total: 1, items: [{ path: "a", reason: "symlink", size: 1 }] }, 'A warning is {"path", "reason"}, with a known reason.'],
		[{ total: 1, items: [{ path: "", reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
		[{ total: 1, items: [{ path: 1, reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
		[{ total: 1, items: [{ path: "a\nb", reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
		[{ total: 1, items: [{ path: "a\u007fb", reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
		[{ total: 1, items: [{ path: "a\ud800b", reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
		[{ total: 1, items: [{ path: "x".repeat(1025), reason: "symlink" }] }, "A warning's path is empty, too long, or has control characters."],
	])("refused: %j", (data, message) => {
		expect(() => parseWarnings(data)).toThrow(new InvalidManifest(message));
	});
});

describe("what a turn changed", () => {
	test("files added, modified (contents or mode) and deleted, and directories, listed or implied", () => {
		const entries = (files: { [path: string]: [string, number] }, dirs: string[] = []) => ({
			files: Object.fromEntries(Object.entries(files).map(([path, [sha256, mode]]) => [path, { sha256, mode, size: 1 }])),
			dirs,
		});
		const before = entries({ "a.txt": ["1", 0o644], "b.txt": ["2", 0o644], "sub/c.txt": ["3", 0o644] }, ["empty/inner"]);
		const after = entries({ "a.txt": ["1", 0o755], "b.txt": ["2", 0o644], "new/deep/d.txt": ["4", 0o644] }, ["x/y"]);
		expect(folderChanges(before, after)).toEqual({
			counts: { added: 1, modified: 1, deleted: 1, dirs_added: 4, dirs_deleted: 3 },
			added: [{ path: "new/deep/d.txt", size: 1 }],
			modified: [{ path: "a.txt", size: 1 }],
			deleted: [{ path: "sub/c.txt", size: 1 }],
			dirs_added: ["new", "new/deep", "x", "x/y"],
			dirs_deleted: ["empty", "empty/inner", "sub"],
		});
		expect(folderChanges(after, after)).toBeNull();
	});

	test("an mtime alone is no change; paths named like Object.prototype's properties are paths", () => {
		const one = { files: { constructor: { sha256: "1", mode: 0o644, size: 1 } }, dirs: [] };
		expect(folderChanges(one, { files: { constructor: { sha256: "1", mode: 0o644, size: 2 } }, dirs: [] })).toBeNull();
		expect(folderChanges({ files: {}, dirs: [] }, one)?.added).toEqual([{ path: "constructor", size: 1 }]);
		expect(folderChanges(one, { files: {}, dirs: [] })?.deleted).toEqual([{ path: "constructor", size: 1 }]);
	});
});

describe("the digest's SHA-256", () => {
	test("equals WebCrypto's at every padding boundary and on a large input", async () => {
		const lengths = [...Array.from({ length: 140 }, (_, i) => i), 1000, 4096, 65_537, 1_000_003];
		for (const length of lengths) {
			const data = new Uint8Array(length);
			for (let i = 0; i < length; i++) data[i] = (i * 31 + length) & 0xff;
			const expected = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
			expect([length, sha256HexSync(data)]).toEqual([length, expected]);
		}
	});

	test("a version at the limits is hashed in well under a second", () => {
		const files = Array.from({ length: 10_000 }, (_, i) => file(`folder ${i % 100}/file ${i}.txt`, A, 0o644, 1_700_000_000_000 + i));
		const entries = storedEntries(parseManifest({ files, dirs: [] }, 20_000), new Map([[A, 12345]]));
		const started = performance.now();
		digestOf(entries);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
