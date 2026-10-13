// The browser walk (plan: Step 5, unit 5f; Step 7): the real frontend, served by the test Worker minerva-cf-test
// as its assets, driven in headless Chrome through its pages. Sign-up with the emailed code and the setup key,
// the first-run setup claimed on its page, the instance admin page, sign-out and sign-in with a password,
// two-factor turned on and used (TOTP computed here, a recovery code), sign-in by emailed code, a password
// reset, an agent, a connection to the fake Notes connector through its OAuth flow, a chat turn with the fake
// model that writes a file, that file downloaded through the app's redirect to the deployed download origin
// minerva-cf-files-test (and that origin refusing the link unsigned, tampered with and expired), one short
// turn with Workers AI, and sign-out. Every page is watched for console errors and warnings, uncaught
// exceptions, failed requests and unexpected error statuses.
//
// The test Worker sends no email: its emails go to a mailbox the token-gated driver reads (src/faults/
// mailbox.ts). The fake provider's consent page is not deployed, so the walk stands in for it through the
// driver (`provider-authorize`). Each walk claims the setup: the driver first deletes an earlier walk's claim
// (`setup-reopen`; the admins it made stay admins).
//
// Run after `pnpm run deploy:test`: `pnpm test:account test/account/browser.test.ts`. Both origins must be the
// test instance's own (origins.ts), or it fails before sending anything. It fails too, rather than skip, without
// the test Worker's settings and secrets (../.env.cloudflare-test.vars, ../.env.cloudflare-test) or when Google
// Chrome does not start. MINERVA_BROWSER_SHOTS=<dir> saves a screenshot of every page there, with every field
// masked.

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FAULTS_HEADER, faultsToken } from "../../src/faults/token.ts";
import { LINK_LIFETIME_MS } from "../../src/files/limits.ts";
import { signDownload } from "../../src/files/links.ts";
import { FALLBACK_RESOLVERS, fetchDeployed, secret, testVar, testWorker } from "./client.ts";
import { chromeFailure, testOrigins } from "./origins.ts";

const TEST_SECRETS = new URL("../../../.env.cloudflare-test", import.meta.url);
const TEST_VARS = new URL("../../../.env.cloudflare-test.vars", import.meta.url);

/**
 * The test Worker's origin, keys and download origin. Missing files, and origins that are not the test instance's
 * own (origins.ts), throw: the walk fails rather than skip.
 */
function setting(): { origin: string; secretKey: string; setupKey: string; downloadOrigin: string; downloadKey: string } {
	if (!existsSync(TEST_VARS) || !existsSync(TEST_SECRETS)) throw new Error("The browser walk needs the test Worker's settings and secrets (cloudflare/README.md, The test Worker).");
	const { origin, secretKey } = testWorker();
	const { downloadOrigin } = testOrigins(origin, testVar("MINERVA_DOWNLOAD_ORIGIN"), { site: "MINERVA_SITE_URL", download: "MINERVA_DOWNLOAD_ORIGIN" });
	return { origin, secretKey, setupKey: secret("MINERVA_SETUP_KEY", TEST_SECRETS), downloadOrigin, downloadKey: secret("MINERVA_DOWNLOAD_KEY", TEST_SECRETS) };
}

/**
 * The addresses of the Workers' host, from the system's resolver or else public ones (as client.ts: some resolvers
 * fail on *.workers.dev now and then), handed to Chrome so a lookup that fails once does not fail a page.
 */
async function addressOf(host: string): Promise<string> {
	try {
		return (await lookup(host, { family: 4 })).address;
	} catch {
		const resolver = new Resolver();
		resolver.setServers(FALLBACK_RESOLVERS);
		const [address] = await resolver.resolve4(host);
		if (!address) throw new Error("no address");
		return address;
	}
}

const worker = setting();
// The app's host and the download origin's. An error would name the host, which stays out of the test's output.
const hosts = [worker.origin, worker.downloadOrigin].map((origin) => new URL(origin).hostname);
const maps: string[] = [];
for (const host of hosts) {
	const address = await addressOf(host).catch(() => {
		throw new Error("A test Worker's host does not resolve, from the system's resolver or public ones");
	});
	maps.push(`MAP ${host} ${address}`);
}
const chrome: Browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--host-resolver-rules=${maps.join(",")}`] }).catch((error: unknown) => {
	throw chromeFailure(error, hosts);
});
const token = await faultsToken(worker.secretKey);

/** MINERVA_BROWSER_SHOTS, which must be outside the repository or ignored by it, so screenshots are never committed. */
function shotsDirectory(): string | undefined {
	const dir = process.env.MINERVA_BROWSER_SHOTS;
	if (!dir) return undefined;
	const absolute = resolve(dir);
	const repository = fileURLToPath(new URL("../../../", import.meta.url));
	if (absolute.startsWith(repository)) {
		try {
			execFileSync("git", ["check-ignore", "-q", absolute], { cwd: repository, stdio: "ignore" });
		} catch {
			throw new Error("MINERVA_BROWSER_SHOTS is in the repository and not ignored by it: choose a directory outside it.");
		}
	}
	return absolute;
}

const SHOTS = shotsDirectory();
/** The codes the walk was sent or made (emailed codes, TOTP codes), left out of its reports. */
const issued: string[] = [];
const PASSWORD = "a walk through every page";
const NEW_PASSWORD = "another walk through every page";
const EMAIL = `browser-walk-${Date.now()}@example.com`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------
// The driver: the mailbox, the fake provider's consent, the download origin, a conversation's model.

async function driver<T>(op: string, body: { [key: string]: unknown }): Promise<T> {
	const reply = await driverReply(op, body);
	if (reply.status !== 200) throw new Error(`${op}: ${reply.status} ${reply.text.slice(0, 300)}`);
	return JSON.parse(reply.text) as T;
}

function driverReply(op: string, body: { [key: string]: unknown }) {
	return fetchDeployed(`${worker.origin}/api/faults/${op}`, {
		method: "POST",
		headers: { [FAULTS_HEADER]: token, "content-type": "application/json" },
		body: JSON.stringify(body),
		timeoutMs: 60_000,
	});
}

interface Captured {
	seq: number;
	to: string;
	subject: string;
	body: string;
}

let lastSeen = 0;

/** The code in the next email to `to` whose subject matches, waiting for it to arrive. */
async function emailedCode(to: string, subject: RegExp): Promise<string> {
	const started = Date.now();
	for (;;) {
		const { emails } = await driver<{ emails: Captured[] }>("emails", { to });
		const email = emails.find((item) => item.seq > lastSeen && subject.test(item.subject));
		if (email) {
			lastSeen = email.seq;
			const code = /\n\n([0-9]{6})(\n|$)/.exec(email.body)?.[1];
			if (!code) throw new Error(`No code in "${email.subject}"`);
			issued.push(code);
			return code;
		}
		if (Date.now() - started > 30_000) throw new Error(`No email to ${to} matching ${subject} (${emails.map((item) => item.subject).join(", ")})`);
		await sleep(500);
	}
}

// ---------------------------------------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, six digits, 30 s), as an authenticator app computes it from the key the page shows.

function base32(text: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const char of text.replace(/=+$/, "").toUpperCase()) {
		const value = alphabet.indexOf(char);
		if (value < 0) throw new Error("The key is not base32.");
		buffer = ((buffer << 5) | value) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 255);
		}
	}
	return Buffer.from(bytes);
}

function totpAt(key: string, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac("sha1", base32(key)).update(counter).digest();
	const offset = (mac[19] as number) & 15;
	return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

let totpKey = "";
let usedStep = 0;

/** A code for a time step the server has not seen used (it refuses a step again), within its ±1 window. */
async function nextTotp(): Promise<string> {
	let now = Math.floor(Date.now() / 30_000);
	while (usedStep + 1 > now + 1) {
		await sleep(2_000);
		now = Math.floor(Date.now() / 30_000);
	}
	usedStep = Math.max(usedStep + 1, now);
	const code = totpAt(totpKey, usedStep);
	issued.push(code);
	return code;
}

// ---------------------------------------------------------------------------------------------------------
// Better Auth's limit per IP and path was 3 requests to /sign-in/* or /two-factor/* while each came within
// 10 s of the one before; it is 10 now (src/accounts/ip-limits.ts), which the walk never reaches. It still
// waits between requests to the same path, as a person would; a run against a deployed build may drop this.

const lastRequest = new Map<string, number>();

async function paced(path: string): Promise<void> {
	const wait = (lastRequest.get(path) ?? 0) + 10_500 - Date.now();
	if (wait > 0) await sleep(wait);
	lastRequest.set(path, Date.now());
}

// ---------------------------------------------------------------------------------------------------------
// What each page did wrong: console errors and warnings, uncaught exceptions, failed requests, error statuses.

interface Problem {
	kind: string;
	text: string;
}

let problems: Problem[] = [];
/** Error statuses a step expects, as "METHOD /path STATUS". */
let expected: RegExp[] = [];
const ALWAYS: RegExp[] = [
	// Signed out, the app asks who is signed in and is told nobody.
	/^GET \/api\/me 401$/,
];

/** The page's latest requests and their answers, for the report of a failed step. */
const trace: { at: number; request: Request; answer: string }[] = [];

function watch(page: Page): void {
	page.on("request", (request) => {
		trace.push({ at: Date.now(), request, answer: "(no answer)" });
		if (trace.length > 80) trace.shift();
	});
	const answered = (request: Request, answer: string) => {
		const entry = trace.find((item) => item.request === request);
		if (entry) entry.answer = `${answer} after ${Date.now() - entry.at} ms`;
	};
	page.on("requestfinished", async (request) => answered(request, String((await request.response())?.status() ?? "?")));
	page.on("requestfailed", (request) => answered(request, request.failure()?.errorText ?? "failed"));
	page.on("console", (message) => {
		if (message.type() !== "error" && message.type() !== "warning") return;
		const text = message.text();
		// Chrome's own line for an error status, reported below with its request.
		if (/^Failed to load resource: the server responded with a status of \d+/.test(text)) return;
		problems.push({ kind: `console.${message.type()}`, text: redact(`${text} (${message.location().url})`) });
	});
	page.on("pageerror", (error) => problems.push({ kind: "pageerror", text: redact(String(error.stack ?? error)) }));
	page.on("requestfailed", (request) => {
		const failure = request.failure()?.errorText ?? "";
		// An event stream or a fetch the page dropped when it navigated, or a download Chrome took over.
		if (failure === "net::ERR_ABORTED") return;
		problems.push({ kind: "requestfailed", text: redact(`${request.method()} ${request.url()} ${failure}`) });
	});
	page.on("response", (response) => {
		if (response.status() < 400) return;
		const url = new URL(response.url());
		const line = `${response.request().method()} ${url.pathname} ${response.status()}`;
		if ([...ALWAYS, ...expected].some((pattern) => pattern.test(line))) return;
		problems.push({ kind: "status", text: line });
	});
}

/**
 * Text for a report (the test's output, failed.txt): without the origins (the test Worker's names its
 * account), any URL's query (codes, states, signatures) or the walk's own secrets.
 */
function redact(text: string): string {
	let out = text.replace(/https?:\/\/[^\s/"'`)]+([^\s?"'`)]*)(\?[^\s"'`)]*)?/g, (_url, path: string, query?: string) => `<origin>${path}${query ? "?<query>" : ""}`);
	for (const secret of [totpKey, ...recovery, ...issued, PASSWORD, NEW_PASSWORD, worker.setupKey, worker.downloadKey]) if (secret) out = out.split(secret).join("<secret>");
	for (const origin of [worker.origin, worker.downloadOrigin]) if (origin) out = out.split(new URL(origin).hostname).join("<host>");
	return out;
}

/** An error for the test's output with its message and stack redacted (a Playwright error names the URL it waited for). */
function redacted(error: unknown): unknown {
	if (!(error instanceof Error)) return new Error(redact(String(error)));
	error.message = redact(error.message);
	if (error.stack) error.stack = redact(error.stack);
	return error;
}

/** Fails the step with every problem its pages had, then starts the next step's list. */
function expectClean(): void {
	const found = problems;
	problems = [];
	expected = [];
	expect(found).toEqual([]);
}

let context: BrowserContext;
let page: Page;
let shot = 0;
let workspaceId = "";
let agentId = "";
let conversationId = "";
let recovery: string[] = [];
/** The links on the download origin that the app redirected Chrome to. */
const signedLinks: string[] = [];

/** A screenshot of the page, once it has loaded, into MINERVA_BROWSER_SHOTS, with every field masked; on the account page, the two-factor key, its QR code and the recovery codes are masked. */
async function screenshot(name: string): Promise<void> {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	if (name !== "failed") await settled();
	const account = /\/account(\/|$)/.test(new URL(page.url()).pathname);
	const secrets = [page.locator("input"), ...(account ? [page.locator("code"), page.locator("svg.bg-white"), page.locator(".font-mono.text-sm")] : [])];
	await page.screenshot({ path: join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`), fullPage: true, mask: secrets });
}

const field = (label: string | RegExp) => page.getByLabel(label, { exact: typeof label === "string" });
const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });

const shown = new Set<string>();
/** A screenshot of a page the walk passes more than once, the first time. */
async function screenshotOnce(name: string): Promise<void> {
	if (shown.has(name)) return;
	shown.add(name);
	await screenshot(name);
}

/** Waits until the page shows no loading spinner. */
async function settled(): Promise<void> {
	const started = Date.now();
	while ((await page.locator(".animate-spin").count()) > 0) {
		if (Date.now() - started > 20_000) throw new Error("The page is still loading after 20 s");
		await sleep(200);
	}
}

/** Waits for the app's workspace pages, and returns the workspace's id. */
async function inApp(): Promise<string> {
	await page.waitForURL(/\/w\/[0-9a-f-]{36}(\/|$)/, { timeout: 30_000 });
	return /\/w\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
}

async function signOut(): Promise<void> {
	// The app empties its cache before it leaves the workspace's pages, whose queries ask again, now signed out.
	expected.push(/^GET \/api\/workspaces\/[0-9a-f-]{36}(\/[a-z]+|\/[a-z]+\/[0-9a-f-]{36})+ 401$/);
	await button("Sign out").first().click();
	await page.waitForURL(/\/login/);
	await page.getByRole("heading", { name: "Sign in" }).waitFor();
}

async function signInWithPassword(password: string): Promise<void> {
	await page.goto(`${worker.origin}/login`);
	await field("Email").fill(EMAIL);
	await field("Password").fill(password);
	await screenshotOnce("login");
	await paced("/sign-in/email");
	await button("Sign in").click();
}

/** The second factor: six digits are an app code, anything else a recovery code. */
async function twoFactor(code: string): Promise<void> {
	await page.waitForURL(/\/login\/mfa/);
	await field("Code").fill(code);
	await screenshotOnce("login-mfa");
	await paced(/^[0-9]{6}$/.test(code) ? "/two-factor/verify-totp" : "/two-factor/verify-backup-code");
	await button("Continue").click();
}

/** The app's own JSON API, from the page (the browser sends its Origin). */
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
	return page.evaluate(
		async ({ method, path, body }) => {
			const response = await fetch(path, {
				method,
				credentials: "same-origin",
				headers: body === undefined ? {} : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
		},
		{ method, path, body },
	);
}

interface Run {
	id: string;
	status: string;
	errorMessage: string;
	resultVersionId: string | null;
}

/** The conversation once it has `runs` runs and the newest has ended (a run the page has only asked for is not counted as one). */
async function ended(runs: number, timeoutMs: number): Promise<{ runs: Run[]; messages: { role: string; content: string; runId: string | null }[] }> {
	const started = Date.now();
	for (;;) {
		const detail = await api<{ runs: Run[]; messages: { role: string; content: string; runId: string | null }[] }>("GET", `/api/workspaces/${workspaceId}/conversations/${conversationId}`);
		expect(detail.status).toBe(200);
		const run = detail.body.runs.at(-1);
		if (run && detail.body.runs.length >= runs && !["queued", "provisioning", "running"].includes(run.status)) return detail.body;
		if (Date.now() - started > timeoutMs) throw new Error(`The run did not end: ${JSON.stringify(run)}`);
		await sleep(2_000);
	}
}

/** The steps depend on each other: after one fails, the rest are skipped rather than timing out one by one. */
let failed: string | null = null;
function step(name: string, body: () => Promise<void>, timeoutMs: number): void {
	test(
		name,
		async (ctx) => {
			if (failed) ctx.skip(`"${failed}" failed`);
			try {
				await body();
			} catch (error) {
				failed = name;
				await screenshot("failed").catch(() => {});
				// Whatever the account page shows of the two-factor key and recovery codes, read or not by the step.
				if (/\/account(\/|$)/.test(new URL(page.url()).pathname)) {
					const shown = await page.locator("code, .font-mono.text-sm span").allTextContents().catch(() => [] as string[]);
					issued.push(...shown.map((text) => text.trim()).filter(Boolean));
				}
				const snapshot = await page.locator("body").ariaSnapshot().catch(() => "");
				if (SHOTS) writeFileSync(join(SHOTS, "failed.txt"), `${redact(page.url())}\n\n${redact(snapshot)}\n\n${JSON.stringify(problems, null, 2)}\n\nRequests:\n${trace.map((item) => `${new Date(item.at).toISOString().slice(11, 23)} ${item.request.method()} ${new URL(item.request.url()).pathname} ${item.answer}`).join("\n")}\n`);
				throw redacted(error);
			}
		},
		timeoutMs,
	);
}

/**
 * Waits until the deploy has settled: for some seconds after one, a page can still come from the previous
 * version while its route chunks, named by their content's hash, are the new version's, so they are 404
 * (the router reloads once, then shows the error). Five answers in a row whose script exists are enough.
 */
async function settledDeploy(): Promise<void> {
	const started = Date.now();
	let good = 0;
	while (good < 5) {
		const html = await fetchDeployed(`${worker.origin}/login`, { timeoutMs: 15_000 });
		const script = /src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/.exec(html.text)?.[1];
		const served = script ? await fetchDeployed(`${worker.origin}${script}`, { timeoutMs: 15_000 }) : null;
		good = served?.status === 200 ? good + 1 : 0;
		if (Date.now() - started > 120_000) throw new Error("The deployed pages and their scripts did not agree for two minutes.");
		if (good < 5) await sleep(1_000);
	}
}

/** The download origin's answer to `url`, from here. */
const fromOrigin = (url: URL) => fetchDeployed(url.href, { timeoutMs: 30_000 });

/**
 * The deployed download origin (minerva-cf-files-test) with the link the app signed: it serves it again, as an
 * attachment, and refuses it without its signature (401), with the signature or a signed field changed (404),
 * and expired (404). The expired link is signed here with the instance's download key, exactly as the app signs
 * (src/files/links.ts), five minutes and a minute before now; the same fields signed now are served, so the
 * refusal is the expiry's alone.
 */
async function refusals(link: URL): Promise<void> {
	expect(link.origin === worker.downloadOrigin && link.pathname === "/download", "the app's redirect leads to the download origin").toBe(true);
	const served = await fromOrigin(link);
	expect(served.status).toBe(200);
	expect(served.text).toBe("written in the browser walk\n");
	expect(served.headers.get("content-type")).toBe("application/octet-stream");
	expect(served.headers.get("content-disposition")).toBe('attachment; filename="report.txt"');
	expect(served.headers.get("cache-control")).toBe("private, no-store");
	expect(served.headers.get("x-content-type-options")).toBe("nosniff");

	const changed = (change: (query: URLSearchParams) => void) => {
		const url = new URL(link);
		change(url.searchParams);
		return url;
	};
	const unsigned = await fromOrigin(changed((query) => query.delete("s")));
	expect([unsigned.status, unsigned.text]).toEqual([401, '{"detail":"Unauthorized"}']);
	const signature = link.searchParams.get("s") ?? "";
	const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
	for (const tampered of [
		changed((query) => query.set("s", flipped)),
		changed((query) => query.set("p", "other.txt")),
		changed((query) => query.set("e", String(Number(query.get("e")) + 3600))),
		changed((query) => query.set("u", "00000000-0000-4000-8000-000000000000")),
	]) {
		const refused = await fromOrigin(tampered);
		expect(refused.status).toBe(404);
		expect(refused.text).not.toContain("written in the browser walk");
	}

	const query = link.searchParams;
	const fields = {
		workspaceId: query.get("w") ?? "",
		jurisdiction: query.get("j") === "eu" ? ("eu" as const) : null,
		conversationId: query.get("c") ?? "",
		versionId: query.get("v") ?? "",
		path: query.get("p") ?? "",
		userId: query.get("u") ?? "",
		key: query.get("k") ?? "",
	};
	const now = await fromOrigin(new URL(await signDownload(worker.downloadKey, worker.downloadOrigin, fields)));
	expect(now.status, "the same fields signed here now are served").toBe(200);
	const expired = await fromOrigin(new URL(await signDownload(worker.downloadKey, worker.downloadOrigin, fields, Date.now() - LINK_LIFETIME_MS - 60_000)));
	expect(expired.status).toBe(404);
	expect(expired.text).not.toContain("written in the browser walk");
}

describe("the browser walk on the test Worker", () => {
	beforeAll(async () => {
		await settledDeploy().catch((error: unknown) => {
			throw redacted(error);
		});
		context = await chrome.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
		// The fake provider's consent page: the user approves, and it redirects to the app's callback with a code.
		await context.route(/^https:\/\/notes\.fake\.invalid\//, async (route) => {
			const consent = await driver<{ code: string; state: string | null; redirectUri: string }>("provider-authorize", {
				workspace: { id: workspaceId, jurisdiction: null },
				userId: "",
				url: route.request().url(),
			});
			const back = new URL(consent.redirectUri);
			back.searchParams.set("code", consent.code);
			if (consent.state !== null) back.searchParams.set("state", consent.state);
			await route.fulfill({ status: 302, headers: { location: back.toString() } });
		});
		// A download goes to the deployed download origin (minerva-cf-files-test) through the app's redirect; the
		// signed link it was redirected to is kept for the refusals. Chrome's download manager makes the requests.
		context.on("request", (request) => {
			const url = new URL(request.url());
			if (url.origin === worker.downloadOrigin && url.pathname === "/download") signedLinks.push(request.url());
		});
		page = await context.newPage();
		watch(page);
	}, 150_000);

	afterAll(async () => {
		await chrome.close();
	});

	step("sign-up with the emailed code and the setup key, the first-run setup claimed on its page, and the instance page", async () => {
		// Each walk claims the setup through its page: an earlier walk's claim is deleted (its admins stay admins).
		await driver("setup-reopen", {});
		await page.goto(`${worker.origin}/signup`);
		await page.getByRole("heading", { name: "Create your account" }).waitFor();
		await field("Email").fill(EMAIL);
		await field("Password").fill(PASSWORD);
		// A server nobody administers offers the setup key at sign-up; with it, verifying leads on to /setup.
		await field("Setup key (optional)").fill(worker.setupKey);
		await screenshot("signup");
		await button("Create account").click();
		await page.waitForURL(/\/verify-email/);
		await field("Verification code").waitFor();
		await screenshot("verify-email");
		await field("Verification code").fill(await emailedCode(EMAIL, /Please Confirm Your Email Address/));
		// Verifying signs in.
		await button("Verify email").click();

		// The first-run setup, claimed with the key on its page.
		await page.waitForURL(/\/setup(\?|$)/, { timeout: 30_000 });
		await field("Setup key").waitFor();
		await screenshot("setup");
		await field("Setup key").fill(worker.setupKey);
		await button("Claim this server").click();
		await page.getByRole("heading", { name: "This server is set up" }).waitFor();
		await screenshot("setup-claimed");
		await page.getByRole("link", { name: "Open Minerva" }).click();
		workspaceId = await inApp();
		await screenshot("signed-up");
		expect((await api<{ needed: boolean }>("GET", "/api/setup")).body).toEqual({ needed: false });
		const me = await api<{ user: { email: string; role: "admin" | "user" } }>("GET", "/api/me");
		expect(me.body.user.email).toBe(EMAIL);
		expect(me.body.user.role).toBe("admin");

		// The instance admin page, from the sidebar's link (shown to admins only), with this admin listed.
		await page.getByRole("link", { name: "Instance", exact: true }).click();
		await page.waitForURL(/\/w\/[0-9a-f-]{36}\/instance$/);
		await page.getByRole("heading", { name: "Instance", exact: true }).waitFor();
		await page.getByRole("heading", { name: "Administrators" }).waitFor();
		await page.getByText(EMAIL, { exact: true }).first().waitFor();
		await screenshot("instance");
		expectClean();
	}, 150_000);

	step("sign-out, and sign-in with the password", async () => {
		await signOut();
		await signInWithPassword(PASSWORD);
		expect(await inApp()).toBe(workspaceId);
		expectClean();
	}, 60_000);

	step("two-factor turned on, then sign-in with an app code", async () => {
		await page.goto(`${worker.origin}/w/${workspaceId}/account`);
		await page.getByText("Two-factor authentication").waitFor();
		await button("Set up").click();
		await field("Current password").fill(PASSWORD);
		await button("Continue").click();
		const key = page.locator("code").filter({ hasText: /^[A-Z2-7]+=*$/ });
		await key.waitFor();
		totpKey = (await key.textContent()) ?? "";
		await screenshot("two-factor-setup");
		await field("Code from the app").fill(await nextTotp());
		await paced("/two-factor/verify-totp");
		await button("Turn on").click();
		await button("I have saved them").waitFor();
		const codes = (await page.locator(".font-mono.text-sm span").allTextContents()).map((code) => code.trim()).filter(Boolean);
		recovery = codes;
		expect(codes.length).toBeGreaterThanOrEqual(8);
		await screenshot("recovery-codes");
		await button("I have saved them").click();
		await page.getByText("On", { exact: true }).waitFor();
		await screenshot("account");

		await signOut();
		await signInWithPassword(PASSWORD);
		await twoFactor(await nextTotp());
		expect(await inApp()).toBe(workspaceId);
		expectClean();
	}, 120_000);

	step("sign-in by emailed code, finished with a recovery code", async () => {
		await signOut();
		await page.goto(`${worker.origin}/login`);
		await button("Sign in with a code").click();
		await field("Email").fill(EMAIL);
		await button("Email me a code").click();
		await page.waitForURL(/\/login\/code/);
		await field("Sign-in code").waitFor();
		await screenshot("login-code");
		await field("Sign-in code").fill(await emailedCode(EMAIL, /sign-in code/));
		await paced("/sign-in/email-otp");
		await button("Sign in").click();
		await twoFactor(recovery[0] as string);
		expect(await inApp()).toBe(workspaceId);
		expectClean();
	}, 90_000);

	step("password reset by emailed code, then sign-in with the new password", async () => {
		await signOut();
		await page.goto(`${worker.origin}/reset-password`);
		await field("Email").fill(EMAIL);
		await screenshot("reset-password");
		await button("Send reset code").click();
		await field("Reset code").waitFor();
		await screenshot("reset-password-code");
		await field("Reset code").fill(await emailedCode(EMAIL, /password reset code/));
		await field("New password").fill(NEW_PASSWORD);
		await button("Set new password").click();
		await page.waitForURL(/\/login/);
		await screenshot("after-reset");
		await signInWithPassword(NEW_PASSWORD);
		await twoFactor(await nextTotp());
		expect(await inApp()).toBe(workspaceId);
		expectClean();
	}, 120_000);

	step("an agent", async () => {
		await page.goto(`${worker.origin}/w/${workspaceId}/agents`);
		await button("New agent").click();
		await field("Name").fill("Walk agent");
		await field("Instructions").fill("You are a test agent. Answer in one short sentence.");
		await button("Create agent").click();
		await page.getByText("Walk agent", { exact: true }).waitFor();
		const agents = await api<{ id: string; name: string }[]>("GET", `/api/workspaces/${workspaceId}/agents`);
		agentId = agents.body.find((agent) => agent.name === "Walk agent")?.id ?? "";
		expect(agentId).not.toBe("");
		await screenshot("agents");
		expectClean();
	}, 60_000);

	step("a connection to the fake Notes connector through its OAuth flow, given to the agent", async () => {
		await page.goto(`${worker.origin}/w/${workspaceId}/connections`);
		await page.getByRole("searchbox", { name: "Search apps" }).waitFor();
		await screenshot("connections");
		await page.getByRole("searchbox", { name: "Search apps" }).fill("Notes");
		await button("Connect Notes").click();
		await page.waitForURL(/\/connections\?connected=/, { timeout: 30_000 });
		await page.getByText("Connected. Choose below what your agents may use.").waitFor();
		await screenshot("connected");
		const connections = await api<{ id: string; provider: string; status: string }[]>("GET", `/api/workspaces/${workspaceId}/connections`);
		const notes = connections.body.find((connection) => connection.provider === "notes");
		expect(notes).toMatchObject({ status: "active" });

		await page.goto(`${worker.origin}/w/${workspaceId}/agents`);
		await page.getByRole("listitem").filter({ hasText: "Walk agent" }).getByRole("button", { name: "Edit" }).click();
		await page.getByRole("checkbox", { name: /Notes/ }).check();
		await button("Save").click();
		await button("Save").waitFor({ state: "hidden" });
		const agent = await api<{ connectionIds: string[] }>("GET", `/api/workspaces/${workspaceId}/agents/${agentId}`);
		expect(agent.body.connectionIds).toEqual([notes?.id]);
		expectClean();
	}, 90_000);

	step("a chat turn with the fake model that writes a file, and the file downloaded through the download origin", async () => {
		await page.goto(`${worker.origin}/w/${workspaceId}/chat?agent=${agentId}`);
		const script = {
			fake: {
				turns: [
					{ tools: [{ name: "bash", arguments: { command: "printf 'written in the browser walk\\n' > report.txt && cat report.txt" } }] },
					{ text: "Wrote report.txt." },
				],
			},
		};
		await page.getByPlaceholder(/Message your agent/).waitFor();
		await screenshot("chat");
		await page.getByPlaceholder(/Message your agent/).fill(JSON.stringify(script));
		await button("Send").click();
		await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
		conversationId = /\/chat\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
		await page.getByText("Wrote report.txt.").waitFor({ timeout: 240_000 });
		const detail = await ended(1, 60_000);
		expect(detail.runs.at(-1)).toMatchObject({ status: "completed", errorMessage: "" });
		await screenshot("fake-turn");

		await button("Files").click();
		// The Files panel's link (the turn's summary links the file too).
		const link = page.getByRole("link", { name: /^report\.txt \d+ B$/ });
		await link.waitFor();
		const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
		expect(download.suggestedFilename()).toBe("report.txt");
		const saved = await download.path();
		expect(readFileSync(saved, "utf8")).toBe("written in the browser walk\n");
		await screenshot("files");
		expectClean();

		// The app redirected Chrome to a link it signed on the download origin, which served the file.
		expect(signedLinks).toHaveLength(1);
		await refusals(new URL(signedLinks[0] as string));
	}, 300_000);

	step("one short turn with Workers AI", async () => {
		// A conversation of its own, made through the API so that it has Workers AI before its first run: a
		// Conversation object keeps the model it first called while it lives.
		const created = await api<{ id: string }>("POST", `/api/workspaces/${workspaceId}/conversations`, { agentId });
		expect(created.status).toBe(201);
		conversationId = created.body.id;
		await driver("conversation-model", { workspace: { id: workspaceId, jurisdiction: null }, userId: "", conversationId, model: "workers-ai" });
		await page.goto(`${worker.origin}/w/${workspaceId}/chat/${conversationId}`);
		await page.getByPlaceholder(/Message your agent/).fill("Say hello in one short sentence. Do not use any tools.");
		await button("Send").click();
		const detail = await ended(1, 180_000);
		const run = detail.runs.at(-1) as Run;
		expect(run, run.errorMessage).toMatchObject({ status: "completed" });
		const answer = detail.messages.filter((message) => message.role === "assistant" && message.runId === run.id).at(-1);
		expect(answer?.content.trim()).toBeTruthy();
		// The fake model's answer to a prompt that is not its script.
		expect(answer?.content.trim()).not.toBe("Done.");
		// The page shows it rendered: compare a stretch of its words without Markdown's marks.
		const words = (answer?.content ?? "").replace(/[*_`#>]/g, "").trim().split("\n")[0]!.slice(0, 30);
		await page.getByText(words, { exact: false }).first().waitFor({ timeout: 30_000 });
		await screenshot("workers-ai-turn");
		expectClean();
	}, 240_000);

	step("sign-out", async () => {
		await signOut();
		const me = await api("GET", "/api/me");
		expect(me.status).toBe(401);
		await screenshot("signed-out");
		expectClean();
	}, 60_000);
});
