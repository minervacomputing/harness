// Drives one journey through the engine's own frontend in headless Chrome, as a seeded user, and keeps the
// evidence (screenshots, a log, downloaded files) in .verify/<time>-<journey>/ at the repository's root.
//
//   node .claude/skills/verify/scripts/journey.ts <journey> [origin]
//
// Journeys: signin, agent, chat, files. The origin defaults to http://localhost:5173 (the frontend's dev server).
// Exits 0 when the journey's end state was observed, 1 otherwise; the last log line says which.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const { chromium } = createRequire(join(root, "cloudflare/package.json"))("playwright-core") as typeof import("playwright-core");

const journeys = ["signin", "agent", "chat", "files"] as const;
type Journey = (typeof journeys)[number];
const journey = process.argv[2] as Journey;
if (!journeys.includes(journey)) {
	console.error(`Usage: node .claude/skills/verify/scripts/journey.ts <${journeys.join("|")}> [origin]`);
	process.exit(2);
}
const origin = new URL(process.argv[3] ?? "http://localhost:5173").origin;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = join(root, ".verify", `${stamp}-${journey}`);
mkdirSync(evidence, { recursive: true });

function log(line: string): void {
	console.log(line);
	appendFileSync(join(evidence, "journey.log"), `${line}\n`);
}

let shots = 0;
async function shot(page: Page, name: string): Promise<void> {
	const file = `${String(++shots).padStart(2, "0")}-${name}.png`;
	await page.screenshot({ path: join(evidence, file), fullPage: true });
	log(`screenshot ${file}`);
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
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

async function signIn(page: Page): Promise<string> {
	await page.goto(`${origin}/login`);
	await page.getByLabel("Email", { exact: true }).fill("ada@example.com");
	await page.getByLabel("Password", { exact: true }).fill("password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL(/\/w\/[0-9a-f-]{36}(\/|$)/, { timeout: 30_000 });
	const workspaceId = /\/w\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
	log(`signed in as ada@example.com, workspace ${workspaceId}`);
	return workspaceId;
}

interface Run {
	id: string;
	status: string;
	errorMessage: string;
}

/** Polls the conversation until its latest run is no longer queued, provisioning or running. */
async function ended(page: Page, workspaceId: string, conversationId: string): Promise<Run> {
	const started = Date.now();
	for (;;) {
		const detail = await api<{ runs: Run[] }>(page, "GET", `/api/workspaces/${workspaceId}/conversations/${conversationId}`);
		const run = detail.body.runs.at(-1);
		if (run && !["queued", "provisioning", "running"].includes(run.status)) return run;
		if (Date.now() - started > 240_000) throw new Error(`The run did not end: ${JSON.stringify(run)}`);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
}

/** Sends one message from New chat and waits for the reply text; returns the conversation's id. */
async function send(page: Page, workspaceId: string, message: string, reply: string): Promise<string> {
	await page.goto(`${origin}/w/${workspaceId}/chat`);
	const box = page.getByPlaceholder(/Message your agent/);
	await box.waitFor();
	await box.fill(message);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 30_000 });
	const conversationId = /\/chat\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
	log(`conversation ${conversationId}`);
	const failed = page.getByText("The agent could not finish this run.", { exact: false });
	await Promise.race([page.getByText(reply, { exact: true }).first().waitFor({ timeout: 240_000 }), failed.first().waitFor({ timeout: 240_000 })]);
	if (await failed.count()) log("the page shows: The agent could not finish this run.");
	return conversationId;
}

const steps: Record<Journey, (page: Page, workspaceId: string) => Promise<void>> = {
	async signin(page) {
		await shot(page, "workspace");
		const me = await api<{ email?: string; user?: { email: string } }>(page, "GET", "/api/me");
		log(`GET /api/me ${me.status}`);
		if (me.status !== 200) throw new Error("/api/me did not answer 200 after sign-in");
	},

	async agent(page, workspaceId) {
		const name = `Verify agent ${stamp}`;
		await page.goto(`${origin}/w/${workspaceId}/agents`);
		await page.getByRole("button", { name: "New agent", exact: true }).click();
		await page.getByLabel("Name", { exact: true }).fill(name);
		await page.getByLabel("Instructions", { exact: true }).fill("Answer in one short sentence.");
		await shot(page, "agent-form");
		await page.getByRole("button", { name: "Create agent", exact: true }).click();
		await page.getByText(name, { exact: true }).waitFor();
		await shot(page, "agents");
		const agents = await api<{ id: string; name: string }[]>(page, "GET", `/api/workspaces/${workspaceId}/agents`);
		const agent = agents.body.find((item) => item.name === name);
		if (!agent) throw new Error(`GET agents does not list "${name}"`);
		log(`agent ${agent.id} listed by GET /api/workspaces/${workspaceId}/agents`);
	},

	async chat(page, workspaceId) {
		const reply = `Verified at ${stamp}.`;
		const conversationId = await send(page, workspaceId, JSON.stringify({ fake: { turns: [{ text: reply }] } }), reply);
		const run = await ended(page, workspaceId, conversationId);
		log(`run ${run.id} ${run.status} ${run.errorMessage}`);
		await shot(page, "reply");
		if (run.status !== "completed") throw new Error(`The run ended ${run.status}`);
		await page.reload();
		await page.getByText(reply, { exact: true }).first().waitFor();
		await shot(page, "reloaded");
		log("the reply is still there after a reload");
	},

	async files(page, workspaceId) {
		const content = `written by verify ${stamp}`;
		const script = {
			fake: {
				turns: [
					{ tools: [{ name: "bash", arguments: { command: `printf '${content}\\n' > verify.txt && cat verify.txt` } }] },
					{ text: "Wrote verify.txt." },
				],
			},
		};
		const conversationId = await send(page, workspaceId, JSON.stringify(script), "Wrote verify.txt.");
		const run = await ended(page, workspaceId, conversationId);
		log(`run ${run.id} ${run.status} ${run.errorMessage}`);
		await shot(page, "turn");
		if (run.status !== "completed") throw new Error(`The run ended ${run.status}`);
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const link = page.getByRole("link", { name: /^verify\.txt \d+ B$/ });
		await link.waitFor();
		await shot(page, "files-panel");
		const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
		const saved = join(evidence, "verify.txt");
		await download.saveAs(saved);
		const body = readFileSync(saved, "utf8");
		log(`downloaded verify.txt: ${JSON.stringify(body)}`);
		if (body !== `${content}\n`) throw new Error("The downloaded file is not what the turn wrote");
	},
};

const problems: string[] = [];
let signedIn = false;
let ok = false;
let page: Page | undefined;
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch((error: unknown) => {
	log(`error: Chrome did not start: ${error instanceof Error ? error.message : String(error)}`);
	return undefined;
});
try {
	if (browser) {
		const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
		page = await context.newPage();
		page.on("console", (message) => {
			// A failed request is recorded from its response below, with its path.
			if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`console: ${message.text()}`);
		});
		page.on("response", (response) => {
			const path = new URL(response.url()).pathname;
			// The login page asks /api/me before anyone has signed in.
			if (response.status() === 401 && path === "/api/me" && !signedIn) return;
			if (response.status() >= 400) problems.push(`${response.request().method()} ${path} ${response.status()}`);
		});
		log(`journey ${journey} against ${origin}`);
		const workspaceId = await signIn(page);
		signedIn = true;
		await steps[journey](page, workspaceId);
		ok = true;
	}
} catch (error) {
	log(`error: ${error instanceof Error ? error.message : String(error)}`);
	if (page) await shot(page, "failure").catch(() => {});
} finally {
	await browser?.close();
}
for (const problem of problems) log(problem);
// A console error or a failed request on the way is a finding even when the end state was reached.
if (problems.length > 0) ok = false;
writeFileSync(join(evidence, "result.json"), JSON.stringify({ journey, origin, ok, problems }, null, 2));
log(`${ok ? "PASS" : "FAIL"} ${journey}; evidence in ${evidence}`);
process.exit(ok ? 0 : 1);
