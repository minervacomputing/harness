// The test build's mailbox and download op (src/faults/mailbox.ts, routes.ts), which the browser walk on the
// test Worker reads (test/account/browser.test.ts): with debug off its emails are kept, never sent (it has no
// Email Sending binding), the token-gated driver reads and empties them, and its `download` op answers a
// signed link as the download origin would, from the build's own bucket.

import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { MAIL_TRANSPORT, codeEmail, sendEmail } from "../../src/accounts/emails.ts";
import { signDownload } from "../../src/files/links.ts";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { hex } from "../../src/lib/bytes.ts";
import { digest, hmac } from "../../src/lib/hash.ts";
import { uuid7 } from "../../src/lib/random.ts";

const ORIGIN = "http://localhost";

/** How the token was derived before 2026-10-13: HMAC-SHA256 of `value` keyed by SHA-256 of `salt + secret`. */
async function retiredToken(salt: string, value: string, secretKey: string): Promise<string> {
	return hex(await hmac("SHA-256", await digest("SHA-256", salt + secretKey), value));
}

async function driver(op: string, body: unknown, token?: string): Promise<Response> {
	return exports.default.fetch(
		new Request(`${ORIGIN}/api/faults/${op}`, {
			method: "POST",
			headers: { [FAULTS_HEADER]: token ?? (await faultsToken(env.MINERVA_SECRET_KEY)), "content-type": "application/json", Origin: ORIGIN },
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
		await sendEmail(quiet, codeEmail("sign-in", to, "123456", ORIGIN, 5));
		await sendEmail(quiet, codeEmail("password-reset", to.toUpperCase(), "654321", ORIGIN, 5));
		await sendEmail(quiet, codeEmail("sign-in", other, "111111", ORIGIN, 5));

		const listed = (await (await driver("emails", { to })).json()) as { emails: Captured[] };
		expect(listed.emails.map((email) => [email.to, email.subject, /\n\n([0-9]{6})\n/.exec(email.body)?.[1]])).toEqual([
			[to, "Your Minerva sign-in code", "123456"],
			[to, "Your Minerva password reset code", "654321"],
		]);
		expect(listed.emails[0]!.seq).toBeLessThan(listed.emails[1]!.seq);

		// Without the driver's token the path is the Worker's, which has no such route (from the site's own
		// origin; from anywhere else it is refused before that, as every unsafe request is). The tokens of earlier
		// derivations (before 2026-10-12, the test Worker's logs kept them whole under the header's old name) and
		// the right token under that old name are refused too.
		const refused = await driver("emails", { to }, "wrong");
		expect(refused.status).toBe(404);
		for (const salt of ["minerva.faults", "minerva.faults-token"]) {
			expect((await driver("emails", { to }, await retiredToken(salt, "faults", env.MINERVA_SECRET_KEY))).status).toBe(404);
		}
		const token = await faultsToken(env.MINERVA_SECRET_KEY);
		const oldName = await exports.default.fetch(
			new Request(`${ORIGIN}/api/faults/emails`, { method: "POST", headers: { "X-Minerva-Faults": token, "content-type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ to }) }),
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
