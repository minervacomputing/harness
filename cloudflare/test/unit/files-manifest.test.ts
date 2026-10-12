// Manifests (files 4, 7.5, 7.7; backend/files/manifest.py and the pure parts of backend/files/runs.py):
// validation in today's order with today's messages, the stored form and its digest, folder sizes,
// warnings and what a turn changed, against the vectors today's Python wrote (files-vectors.py), and
// test_files_manifest.py ported case by case.

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
import { hex } from "../../src/lib/bytes.ts";
import { canonicalUtf8, type Json, parseJson } from "../../src/lib/json.ts";
import { filesVectors } from "./files-support.ts";

const vectors = filesVectors();
const A = "a".repeat(64);
const B = "b".repeat(64);

function file(path: unknown, sha256: unknown = A, mode: unknown = 0o644, mtime: unknown = 0) {
	return { path, sha256, mode, mtime };
}

/** `parse` as the vectors record it: the parsed form, or the refusal. */
function outcome(call: () => Json): Json {
	try {
		return { ok: call() };
	} catch (error) {
		if (error instanceof InvalidManifest) return { invalid: error.message };
		if (error instanceof QuotaExceeded) return { quota: error.limit };
		throw error;
	}
}

function parsed(data: unknown, maxEntries: number): Json {
	const manifest = parseManifest(data, maxEntries);
	const files: { [path: string]: Json } = {};
	for (const [path, entry] of manifest.files) Object.defineProperty(files, path, { value: [entry.sha256, entry.mode, entry.mtime], enumerable: true });
	return { files, dirs: manifest.dirs, entry_count: manifest.entryCount, hashes: [...new Set([...manifest.files.values()].map((entry) => entry.sha256))].sort() };
}

describe("Python's vectors", () => {
	test("they come from the Unicode version the scan's names are checked against", () => {
		// Python 3.14's tables; the runtime's ICU may differ for characters assigned since (files risk 23).
		expect(vectors.unicode).toBe("16.0.0");
	});

	test("manifests: the parse, or the refusal with its message", () => {
		const cases = vectors.manifest as { data: Json; max_entries: number; outcome: Json }[];
		expect(cases.length).toBeGreaterThan(70);
		for (const { data, max_entries, outcome: expected } of cases) {
			const actual = outcome(() => parsed(data, max_entries));
			expect([data, actual]).toEqual([data, expected]);
			// Python's dict keeps the order files were given in, and so does the parse.
			if ("ok" in (expected as object)) {
				expect(Object.keys((actual as { ok: { files: object } }).ok.files)).toEqual(Object.keys((expected as { ok: { files: object } }).ok.files));
			}
		}
	});

	test("digests and stored forms, whatever the input's order", () => {
		for (const vector of vectors.digest as { data: Json; sizes: { [hash: string]: number }; entries: Json; digest: string; folder_bytes: number }[]) {
			const entries = storedEntries(parseManifest(vector.data, 100), new Map(Object.entries(vector.sizes)));
			expect(entries).toEqual(vector.entries);
			expect(filesOf(entries).map(([path]) => path)).toEqual(filesOf(vector.entries as unknown as StoredEntries).map(([path]) => path));
			expect(digestOf(entries)).toBe(vector.digest);
			expect(entriesBytes(entries)).toBe(vector.folder_bytes);
		}
	});

	test("folder bytes round each file up to whole pages", () => {
		for (const vector of vectors.folder_bytes as { sizes: number[]; bytes: number }[]) expect(folderBytes(vector.sizes)).toBe(vector.bytes);
	});

	test("what a turn changed", () => {
		for (const vector of vectors.folder_changes as { before: Json; after: Json; changes: Json }[]) {
			expect(folderChanges(vector.before as never, vector.after as never)).toEqual(vector.changes);
		}
	});

	test("warnings: the stored form, or the refusal", () => {
		for (const { data, outcome: expected } of vectors.warnings as { data: Json; outcome: Json }[]) {
			const actual = outcome(() => parseWarnings(data) as unknown as Json);
			if (JSON.stringify(data) === '{"total":1,"items":[]}' && "invalid" in (expected as object)) {
				// Python's `1.0`, a float it refuses as a total; a parsed or cloned JavaScript number cannot be
				// told from 1 (files risk 4, a harmless widening: the count is right).
				expect(actual).toEqual({ ok: { total: 1, items: [] } });
				continue;
			}
			expect([data, actual]).toEqual([data, expected]);
		}
	});
});

// test_files_manifest.py

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
	test("paths that are object keys in JavaScript stay own entries, in code point order", () => {
		const paths = ["__proto__", "constructor", "10", "9", "\u{1F600}", "", "Z"];
		const manifest = parseManifest({ files: paths.map((path) => file(path)), dirs: [] }, 100);
		const entries = storedEntries(manifest, new Map([[A, 3]]));
		expect(Object.hasOwn(entries.files, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(entries.files)).toBe(Object.prototype);
		// Code point order puts U+E000 before an emoji, which UTF-16 order would not; and "10" before "9".
		expect(filesOf(entries).map(([path]) => path)).toEqual(["10", "9", "Z", "__proto__", "constructor", "", "\u{1F600}"]);
		const text = canonicalUtf8(entries);
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

describe("what a turn changed", () => {
	// test_files_web.py: test_a_turns_changes_list_files_and_directories.
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
