// Names, types and messages of agent files: cleaned and numbered names, sniffed media types, sizes in
// words, the upload's `?name=`, and the folder-limit messages.

import { describe, expect, test } from "vitest";
import { folderLimitMessage, mib, overFolder } from "../../src/files/limits.ts";
import { cleanName, numbered, sniff, uploadName } from "../../src/files/names.ts";

const encoder = new TextEncoder();

describe("names and types", () => {
	test.each([
		["report.pdf", "report.pdf"],
		["C:\\Users\\ada\\report.pdf", "report.pdf"],
		["../../etc/passwd", "passwd"],
		["../Q3 report.pdf", "Q3 report.pdf"],
		["..", "file"],
		[".", "file"],
		["", "file"],
		["  ", "file"],
		["\0\x01", "file"],
		[" x.txt ", "x.txt"],
		["trailing \u3000", "trailing"],
		["\ufeffbom.txt", "bom.txt"],
		["a\ud800b.txt", "ab.txt"],
		[".bashrc", ".bashrc"],
		["...", "..."],
		["evil\u202egnp.exe", "evilgnp.exe"],
		["a\nb.txt", "ab.txt"],
		["Cafe\u0301.txt", "Café.txt"],
		["x".repeat(300) + ".txt", "x".repeat(251) + ".txt"],
		// An extension is kept when it has at most 16 characters with its dot.
		[`${"x".repeat(300)}.${"e".repeat(15)}`, `${"x".repeat(239)}.${"e".repeat(15)}`],
		[`${"x".repeat(300)}.${"e".repeat(16)}`, "x".repeat(255)],
		["\u00e9".repeat(200) + ".txt", "\u00e9".repeat(125) + ".txt"],
	])("a file name is cleaned: %j", (raw, clean) => {
		expect(cleanName(raw)).toBe(clean);
	});

	test("a taken name is numbered before its extension", () => {
		expect(numbered("a.txt", new Set())).toBe("a.txt");
		expect(numbered("a.txt", new Set(["a.txt", "a (2).txt"]))).toBe("a (3).txt");
		expect(numbered("archive.tar.gz", new Set(["archive.tar.gz"]))).toBe("archive.tar (2).gz");
		expect(numbered("README", new Set(["README"]))).toBe("README (2)");
		const long = "x".repeat(251) + ".txt";
		expect(numbered(long, new Set([long]))).toBe("x".repeat(247) + " (2).txt");
		expect(numbered(".bashrc", new Set([".bashrc"]))).toBe(".bashrc (2)");
		expect(numbered("a", new Set(["a", ...Array.from({ length: 10 }, (_, i) => `a (${i + 2})`)]))).toBe("a (12)");
	});

	test("a surrogate pair is never split when a name is shortened", () => {
		const name = cleanName("\u{1F600}".repeat(70));
		expect(name.isWellFormed()).toBe(true);
		expect(encoder.encode(name).length).toBeLessThanOrEqual(255);
		expect(name).toBe("\u{1F600}".repeat(63));
	});

	test.each([
		["%PDF-1.7", "a.txt", "application/pdf"],
		["\x89PNG\r\n\x1a\n", "a.pdf", "image/png"],
		["\xff\xd8\xff\xe0", "a.bin", "image/jpeg"],
		["GIF89a", "a", "image/gif"],
		["RIFF\0\0\0\0WEBPVP8 ", "a", "image/webp"],
		["RIFF\0\0\0\0WAVE", "a.wav", "application/octet-stream"],
		["PK\x03\x04", "a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["PK\x03\x04", "a.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["PK\x03\x04", "a.ods", "application/vnd.oasis.opendocument.spreadsheet"],
		["PK\x03\x04", "a.zip", "application/zip"],
		["\x1f\x8b", "a.gz", "application/gzip"],
		["a,b\n1,2\n", "a.csv", "text/csv"],
		['{"a": 1}', "a.tar.json", "application/json"],
		["# Title", "a.md", "text/markdown"],
		["a\tb", ".tsv", "text/plain"],
		["a\0b", "a.txt", "application/octet-stream"],
		["<html><script>", "a.html", "text/plain"],
		["", "empty", "text/plain"],
		// Up to three bytes at the end may be a cut character; a fourth invalid byte is not text.
		["ok\xff\xff\xff", "a", "text/plain"],
		["ok\xff\xff\xff\xff", "a", "application/octet-stream"],
	])("the media type comes from the contents: %j as %s", (head, name, mediaType) => {
		expect(sniff(Uint8Array.from(head, (char) => char.charCodeAt(0)), name)).toBe(mediaType);
	});

	test("UTF-8 cut inside a character is still text", () => {
		expect(sniff(encoder.encode("zażółć").slice(0, -1), "a.txt")).toBe("text/plain");
	});
});

describe("the upload's name", () => {
	test.each([
		["name=report.pdf", "report.pdf"],
		["name=Q3+report.pdf", "Q3 report.pdf"],
		["name=Q3%20report.pdf", "Q3 report.pdf"],
		["name=%E2%82%AC.txt", "\u20ac.txt"],
		["%6Eame=a", "a"],
		["name=a=b", "a=b"],
		["name=&name=a", "a"],
		["a=1&name=x&b=2", "x"],
		["&&name=a&&", "a"],
		["name=%00", "\0"],
		// Exactly one non-empty name, with escapes that are UTF-8.
		["name=a&name=b", null],
		["name=", null],
		["name", null],
		["", null],
		["other=1", null],
		["name=%E2%82.txt", null],
		["name=%ff", null],
		["name=a%", null],
		["name=%zz", null],
	])("%j", (query, name) => {
		expect(uploadName(query)).toBe(name);
	});
});

describe("messages", () => {
	const limits = { folderBytes: 268_435_456, folderEntries: 10_000, runUploadBytes: 4 * 268_435_456 };

	test("a run over a folder limit fails with the gateway's own words, the entries without a thousands separator", () => {
		expect(folderLimitMessage("folder_bytes", limits)).toBe("The agent's files grew past the 256 MiB a conversation can keep.");
		expect(folderLimitMessage("folder_entries", limits)).toBe("The agent made more than the 10000 files and folders a conversation can keep.");
		expect(folderLimitMessage("run_uploads", limits)).toBe("The agent saved more than the 1024 MiB of files a turn may save.");
		expect(folderLimitMessage("workspace", limits)).toBe("The workspace has used all of its storage for files.");
		expect(folderLimitMessage("folder_bytes", { ...limits, folderBytes: 3 })).toBe("The agent's files grew past the 3 bytes a conversation can keep.");
	});

	test("attachments over a folder limit are refused with a thousands separator", () => {
		expect(overFolder("folder_entries", 10_000, limits.folderBytes)).toBe("These files would put more than 10,000 files and folders in this conversation's folder.");
		expect(overFolder("folder_bytes", 10_000, limits.folderBytes)).toBe("These files would make this conversation's folder larger than 256 MB.");
		expect([mib(2 ** 20), mib(2 ** 30), mib(1.5 * 2 ** 20), mib(2 ** 20 - 1), mib(0)]).toEqual(["1 MiB", "1024 MiB", "2 MiB", "1048575 bytes", "0 bytes"]);
	});
});
