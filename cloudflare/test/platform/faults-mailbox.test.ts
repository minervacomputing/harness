// The test build's mailbox and download op (src/faults/mailbox.ts, routes.ts), which the browser walk on the
// test Worker reads (test/account/browser.test.ts): with debug off its emails are kept, never sent (it has no
// Email Sending binding), the token-gated driver reads and empties them, and its `download` op answers a
// signed link as the download origin would, from the build's own bucket.

import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { MAIL_TRANSPORT, render, sendEmail } from "../../src/accounts/emails.ts";
import { signDownload } from "../../src/files/links.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { saltedHmacHex } from "../../src/lib/hash.ts";
import { uuid7 } from "../../src/lib/random.ts";

const ORIGIN = "http://localhost";

async function driver(op: string, body: unknown, token?: string): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/faults/${op}`, {
			method: "POST",
			headers: { [FAULTS_HEADER]: token ?? (await faultsToken(env.MINERVA_SECRET_KEY)), "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

interface Captured {
	seq: number;
	to: string;
	subject: string;
	body: string;
}

describe("the test build's mailbox", () => {
	test("keeps the emails it would send, for the driver only", async () => {
		expect("EMAIL" in env).toBe(false);
		expect(MAIL_TRANSPORT.send).not.toBeNull();
		const to = `mailbox-${uuid7()}@example.com`;
		const other = `mailbox-${uuid7()}@example.com`;
		// Debug off, as on the deployed test Worker: the email goes to the mailbox, not the log.
		const quiet = { ...env, MINERVA_DEBUG: "false" };
		await sendEmail(quiet, render("login_code", to, ORIGIN, "123456"));
		await sendEmail(quiet, render("password_reset_code", to.toUpperCase(), ORIGIN, "654321"));
		await sendEmail(quiet, render("login_code", other, ORIGIN, "111111"));

		const listed = (await (await driver("emails", { to })).json()) as { emails: Captured[] };
		expect(listed.emails.map((email) => [email.to, email.subject, /\n\n([0-9]{6})\n/.exec(email.body)?.[1]])).toEqual([
			[to, "[Minerva] Sign-In Code", "123456"],
			[to, "[Minerva] Password Reset Code", "654321"],
		]);
		expect(listed.emails[0]!.seq).toBeLessThan(listed.emails[1]!.seq);

		// Without the driver's token the path is the Worker's, which has no such route. The token of before
		// 2026-10-12, which the test Worker's logs kept whole under the header's old name, is refused too.
		const refused = await driver("emails", { to }, "wrong");
		expect(refused.status).toBe(404);
		const retired = await saltedHmacHex("minerva.faults", "faults", env.MINERVA_SECRET_KEY, "SHA-256");
		expect((await driver("emails", { to }, retired)).status).toBe(404);
		const oldName = await exports.default.fetch(
			new Request(`${ORIGIN}/api/faults/emails`, { method: "POST", headers: { "X-Minerva-Faults": retired, "content-type": "application/json" }, body: JSON.stringify({ to }) }),
		);
		expect(oldName.status).toBe(404);
		expect(await refused.text()).not.toContain("123456");

		expect(await (await driver("emails-clear", { to })).json()).toEqual({ cleared: 2 });
		expect(await (await driver("emails", { to })).json()).toEqual({ emails: [] });
		expect(((await (await driver("emails", { to: other })).json()) as { emails: Captured[] }).emails).toHaveLength(1);
	});
});

describe("the driver's download op", () => {
	test("answers a signed link as the download origin, and refuses a tampered one", async () => {
		const workspaceId = uuid7();
		const conversationId = uuid7();
		const key = `blobs/${workspaceId}/${conversationId}/${"a".repeat(64)}/${"b".repeat(32)}`;
		await env.FILES.put(key, "written by python\n");
		const link = { workspaceId, jurisdiction: null, conversationId, versionId: uuid7(), path: "out/report.txt", userId: uuid7(), key };
		const url = await signDownload(env.MINERVA_DOWNLOAD_KEY, env.MINERVA_DOWNLOAD_ORIGIN, link);

		const served = await driver("download", { url });
		expect(served.status).toBe(200);
		expect(served.headers.get("content-disposition")).toContain("report.txt");
		expect(served.headers.get("content-security-policy")).toBe("sandbox");
		expect(await served.text()).toBe("written by python\n");

		const tampered = new URL(url);
		tampered.searchParams.set("p", "out/other.txt");
		expect((await driver("download", { url: tampered.toString() })).status).toBe(404);
		const elsewhere = await signDownload(env.MINERVA_DOWNLOAD_KEY, "https://files.example.com", link);
		expect((await driver("download", { url: elsewhere })).status).toBe(404);
	});
});
