// Download links and headers (files 11.2; plan: Files, Downloads): Content-Disposition exactly as Django
// writes it (against the vectors), urllib's quote, links signed with MINERVA_DOWNLOAD_KEY over the origin,
// workspace, conversation, version, path, user, object and a five-minute expiry, and the byte ranges the
// download origin serves.

import { describe, expect, test } from "vitest";
import { parseRange, servedRange } from "../../src/files/download.ts";
import { LINK_LIFETIME_MS } from "../../src/files/limits.ts";
import { contentDisposition, type DownloadLink, downloadLinkFor, quote, signDownload, verifyDownload } from "../../src/files/links.ts";
import { filesVectors } from "./files-support.ts";

const vectors = filesVectors();
const KEY = "a-download-key-for-these-tests-only";
const ORIGIN = "https://files.minerva.example";
const NOW = 1_760_000_000_000;
const LINK: Omit<DownloadLink, "expires"> = {
	workspaceId: "0199a000-0000-7000-8000-0000000000a1",
	jurisdiction: null,
	conversationId: "0199a000-0000-7000-8000-0000000000c1",
	versionId: "0199a000-0000-7000-8000-0000000000e1",
	path: "reports/zażółć report & co+1.html",
	userId: "0199a000-0000-7000-8000-0000000000d1",
	key: `blobs/0199a000-0000-7000-8000-0000000000a1/0199a000-0000-7000-8000-0000000000c1/${"b".repeat(64)}/${"0".repeat(32)}`,
};

describe("Content-Disposition", () => {
	test("as Django's content_disposition_header(True, name) writes it", () => {
		for (const { name, header } of vectors.content_disposition as { name: string; header: string }[]) expect([name, contentDisposition(name)]).toEqual([name, header]);
	});

	test("today's download: the UTF-8 form without an ASCII fallback", () => {
		expect(contentDisposition("zażółć report.html")).toBe("attachment; filename*=utf-8''za%C5%BC%C3%B3%C5%82%C4%87%20report.html");
		expect(contentDisposition('say "hi"\\.txt')).toBe('attachment; filename="say \\"hi\\"\\\\.txt"');
	});

	test("quote keeps letters, digits, _.-~ and /, and escapes every other byte", () => {
		expect(quote("a b/c~d_e.f-g")).toBe("a%20b/c~d_e.f-g");
		expect(quote("\u{1F600}")).toBe("%F0%9F%98%80");
		expect(quote("!*'();:@&=+$,?#[]")).toBe("%21%2A%27%28%29%3B%3A%40%26%3D%2B%24%2C%3F%23%5B%5D");
	});
});

describe("signed links", () => {
	async function signed(link = LINK, now = NOW) {
		return new URL(await signDownload(KEY, ORIGIN, link, now));
	}

	test("a link names its file and expires five minutes after it was made", async () => {
		const url = await signed();
		expect(url.origin).toBe(ORIGIN);
		expect(url.pathname).toBe("/download");
		const verified = await verifyDownload(KEY, url, NOW);
		expect(verified).toEqual({ ok: true, link: { ...LINK, expires: Math.floor((NOW + LINK_LIFETIME_MS) / 1000) } });
		expect((await verifyDownload(KEY, url, NOW + LINK_LIFETIME_MS)).ok).toBe(true);
		expect(await verifyDownload(KEY, url, NOW + LINK_LIFETIME_MS + 1000)).toEqual({ ok: false, reason: "invalid" });
	});

	test("an EU workspace's link says so, signed", async () => {
		const url = await signed({ ...LINK, jurisdiction: "eu" });
		expect((await verifyDownload(KEY, url, NOW)) as unknown).toMatchObject({ ok: true, link: { jurisdiction: "eu" } });
		url.searchParams.delete("j");
		expect(await verifyDownload(KEY, url, NOW)).toEqual({ ok: false, reason: "invalid" });
	});

	test("without a signature: unsigned (401); anything else wrong: invalid (404)", async () => {
		const url = await signed();
		const without = new URL(url);
		without.searchParams.delete("s");
		expect(await verifyDownload(KEY, without, NOW)).toEqual({ ok: false, reason: "unsigned" });
		without.searchParams.set("s", "");
		expect(await verifyDownload(KEY, without, NOW)).toEqual({ ok: false, reason: "unsigned" });
		expect(await verifyDownload("another-key", url, NOW)).toEqual({ ok: false, reason: "invalid" });
		// Every field is signed.
		for (const [name, value] of [
			["w", "0199a000-0000-7000-8000-0000000000a2"],
			["c", "0199a000-0000-7000-8000-0000000000c2"],
			["v", "0199a000-0000-7000-8000-0000000000e2"],
			["u", "0199a000-0000-7000-8000-0000000000d2"],
			["p", "reports/other.html"],
			["k", `${LINK.key.slice(0, -1)}1`],
			["e", String(Math.floor(NOW / 1000) + 3600)],
			["j", "eu"],
		] as const) {
			const changed = new URL(url);
			changed.searchParams.set(name, value);
			expect([name, await verifyDownload(KEY, changed, NOW)]).toEqual([name, { ok: false, reason: "invalid" }]);
		}
		// Another origin, a field given twice, a key outside the conversation's blobs, a malformed id.
		const elsewhere = new URL(url.pathname + url.search, "https://minerva.example");
		expect(await verifyDownload(KEY, elsewhere, NOW)).toEqual({ ok: false, reason: "invalid" });
		const twice = new URL(url);
		twice.searchParams.append("p", LINK.path);
		expect(await verifyDownload(KEY, twice, NOW)).toEqual({ ok: false, reason: "invalid" });
		const foreign = await signed({ ...LINK, key: `uploads/${LINK.workspaceId}/${LINK.userId}/${LINK.versionId}` });
		expect(await verifyDownload(KEY, foreign, NOW)).toEqual({ ok: false, reason: "invalid" });
		const upper = await signed({ ...LINK, userId: LINK.userId.toUpperCase() });
		expect(await verifyDownload(KEY, upper, NOW)).toEqual({ ok: false, reason: "invalid" });
	});

	test("the link for a resolved file names its workspace's jurisdiction and its object", async () => {
		const url = new URL(
			await downloadLinkFor(
				KEY,
				ORIGIN,
				{ workspace: { id: LINK.workspaceId, jurisdiction: "eu" }, conversationId: LINK.conversationId, userId: LINK.userId, target: { versionId: LINK.versionId, path: LINK.path, key: LINK.key } },
				NOW,
			),
		);
		expect(await verifyDownload(KEY, url, NOW)).toEqual({ ok: true, link: { ...LINK, jurisdiction: "eu", expires: Math.floor((NOW + LINK_LIFETIME_MS) / 1000) } });
	});

	test("a path survives the query exactly, spaces, plus signs and ampersands included", async () => {
		for (const path of ["a+b c.txt", "x&y=z", "%41.txt", "dir/\u{1F600}.png", "__proto__"]) {
			const url = await signed({ ...LINK, path });
			const verified = await verifyDownload(KEY, url, NOW);
			expect(verified.ok && verified.link.path).toBe(path);
		}
	});
});

describe("byte ranges", () => {
	test("one range of bytes=, or the whole file", () => {
		expect(parseRange(null)).toBeNull();
		expect(parseRange("bytes=100-199")).toEqual({ offset: 100, length: 100 });
		expect(parseRange("bytes=100-")).toEqual({ offset: 100 });
		expect(parseRange("bytes=-5")).toEqual({ suffix: 5 });
		for (const ignored of ["bytes=-0", "bytes=5-4", "bytes=0-1,4-5", "items=0-1", "bytes=-", "bytes=a-b"]) expect([ignored, parseRange(ignored)]).toEqual([ignored, null]);
	});

	test("what a ranged get served, a suffix and an end past the file resolved", () => {
		expect(servedRange({ suffix: 3 }, 10)).toEqual({ offset: 7, length: 3 });
		expect(servedRange({ suffix: 20 }, 10)).toEqual({ offset: 0, length: 10 });
		expect(servedRange({ offset: 2 }, 10)).toEqual({ offset: 2, length: 8 });
		expect(servedRange({ offset: 8, length: 5 }, 10)).toEqual({ offset: 8, length: 2 });
		expect(servedRange({ offset: 7, length: 3 }, 10)).toEqual({ offset: 7, length: 3 });
	});
});
