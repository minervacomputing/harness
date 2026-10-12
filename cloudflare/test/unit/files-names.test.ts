// Names, types and messages of agent files (files 2, 7.10, 9, 10; backend/files/uploads.py, upload_app.py
// and gateway/views.py): clean_name, numbered, sniff, size_text, _mib, the upload's `?name=`, the
// request checks made before an upload's body, and the folder-limit messages, against the vectors
// today's Python wrote and test_files_web.py's cases.

import { describe, expect, test } from "vitest";
import { folderLimitMessage, mib, uploadTooLarge } from "../../src/files/limits.ts";
import { cleanName, numbered, sniff, uploadName } from "../../src/files/names.ts";
import { checkUploadRequest } from "../../src/files/uploads.ts";
import { fromBase64 } from "../../src/lib/bytes.ts";
import { overFolder, sizeText } from "../../src/workspace/limits.ts";
import { filesVectors } from "./files-support.ts";

const vectors = filesVectors();
const encoder = new TextEncoder();

describe("Python's vectors", () => {
	test("clean_name", () => {
		for (const { raw, clean } of vectors.clean_name as { raw: string; clean: string }[]) expect([raw, cleanName(raw)]).toEqual([raw, clean]);
	});

	test("numbered", () => {
		for (const { name, taken, numbered: expected } of vectors.numbered as { name: string; taken: string[]; numbered: string }[]) {
			expect([name, numbered(name, new Set(taken))]).toEqual([name, expected]);
		}
	});

	test("sniff", () => {
		for (const { head, name, media_type } of vectors.sniff as { head: string; name: string; media_type: string }[]) {
			expect([head, name, sniff(fromBase64(head), name)]).toEqual([head, name, media_type]);
		}
	});

	test("size_text and _mib", () => {
		for (const { bytes, text } of vectors.size_text as { bytes: number; text: string }[]) expect([bytes, sizeText(bytes)]).toEqual([bytes, text]);
		for (const { bytes, text } of vectors.mib as { bytes: number; text: string }[]) expect([bytes, mib(bytes)]).toEqual([bytes, text]);
	});

	test("the upload's name from its query: exactly one non-blank `name`", () => {
		for (const { query, names } of vectors.query_names as { query: string; names: string[] | null }[]) {
			expect([query, uploadName(query)]).toEqual([query, names !== null && names.length === 1 ? names[0] : null]);
		}
	});
});

// test_files_web.py

describe("names and types", () => {
	test.each([
		["report.pdf", "report.pdf"],
		["C:\\Users\\ada\\report.pdf", "report.pdf"],
		["../../etc/passwd", "passwd"],
		["..", "file"],
		["  ", "file"],
		["evil\u202egnp.exe", "evilgnp.exe"],
		["a\nb.txt", "ab.txt"],
		["Cafe\u0301.txt", "Café.txt"],
		["x".repeat(300) + ".txt", "x".repeat(251) + ".txt"],
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
		["PK\x03\x04", "a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["PK\x03\x04", "a.zip", "application/zip"],
		["a,b\n1,2\n", "a.csv", "text/csv"],
		["a\0b", "a.txt", "application/octet-stream"],
		["<html><script>", "a.html", "text/plain"],
	])("the media type comes from the contents: %j as %s", (head, name, mediaType) => {
		expect(sniff(Uint8Array.from(head, (char) => char.charCodeAt(0)), name)).toBe(mediaType);
	});

	test("UTF-8 cut inside a character is still text", () => {
		expect(sniff(encoder.encode("zażółć").slice(0, -1), "a.txt")).toBe("text/plain");
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
		expect(uploadTooLarge(52_428_800)).toBe("A file can be at most 50 MB.");
	});
});

describe("an upload's request, before its body (files 9.1, checks 2 to 7)", () => {
	const url = "https://minerva.example/api/workspaces/0199a000-0000-7000-8000-000000000001/uploads";
	const request = (init: { method?: string; length?: string | null; query?: string }) => {
		const headers = new Headers();
		if (init.length !== null) headers.set("content-length", init.length ?? "5");
		return { method: init.method ?? "POST", headers, url: `${url}${init.query ?? "?name=..%2FQ3%20report.pdf"}` };
	};

	test("POST, one Content-Length of digits at most the limit, then exactly one name, cleaned", () => {
		expect(checkUploadRequest(request({}), 10)).toEqual({ ok: true, value: { size: 5, name: "Q3 report.pdf" } });
		expect(checkUploadRequest(request({ method: "PUT", length: null, query: "" }), 10)).toEqual({ ok: false, refusal: { status: 405, detail: "Use POST." } });
		expect(checkUploadRequest(request({ length: null, query: "" }), 10)).toEqual({ ok: false, refusal: { status: 411, detail: "Send a Content-Length." } });
		// Headers strip a value's surrounding whitespace, as the HTTP servers in front of Python's app do.
		for (const length of ["-5", "", "5, 5", "0x5", "5.0", "+5"]) {
			expect(checkUploadRequest(request({ length, query: "" }), 10)).toEqual({ ok: false, refusal: { status: 400, detail: "Invalid Content-Length." } });
		}
		expect(checkUploadRequest(request({ length: "11", query: "" }), 10)).toEqual({ ok: false, refusal: { status: 413, detail: "A file can be at most 9.53674e-06 MB." } });
		expect(checkUploadRequest(request({ length: "52428801", query: "" }), 52_428_800)).toEqual({ ok: false, refusal: { status: 413, detail: "A file can be at most 50 MB." } });
		for (const query of ["", "?name=", "?name=a&name=b", "?other=1", "?name=%ff"]) {
			expect(checkUploadRequest(request({ query }), 10)).toEqual({ ok: false, refusal: { status: 400, detail: "Name the file with ?name=." } });
		}
		expect(checkUploadRequest(request({ length: "0", query: "?name=.." }), 10)).toEqual({ ok: true, value: { size: 0, name: "file" } });
	});
});
