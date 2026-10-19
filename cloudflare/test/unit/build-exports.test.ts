// What each build of cloudflare.config.ts exports: its Durable Object classes, live or deleted, against the classes its
// entry's code exports. No build exports Workspace or FaultMailbox, live or deleted: 13c retired them, so an instance's
// namespace of either is a stray, which stops the deploy until a tombstone's deploy has deleted it.
// Each build is a real `cf build` in a temporary checkout of symbolic links, so the
// checkout's own .cloudflare/output/ is left alone; no build reaches an account.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type BuiltWorker, strayClasses } from "../../scripts/builds.ts";
import { createInstance } from "../../scripts/instance-files.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CF = join(ROOT, "node_modules", ".bin", "cf");
const IMAGE = `minerva-sandbox:${"a".repeat(24)}@sha256:${"b".repeat(64)}`;
/** What the deploy reads from models.dev for the default route (scripts/model-prices.ts), which a deployed build needs. */
const PRICES = JSON.stringify({ provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", input: 150_000, cachedInput: 30_000, cacheWrite: 150_000, output: 500_000 });

let base: string;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "build-exports-"));
	for (const [name, isTest] of [["acme", false], ["acme-test", true]] as const) {
		createInstance(join(base, "instances"), name, isTest);
		writeFileSync(join(base, "instances", name, "vars.env"), "", { mode: 0o600 });
	}
	// A docker that never answers, so that the dev server's mode builds no container image.
	mkdirSync(join(base, "bin"));
	writeFileSync(join(base, "bin", "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
});
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

interface Built {
	config: BuiltWorker & { env: Record<string, { type?: string; exportName?: string }> };
	/** The names the entry module's code exports. */
	code: string[];
}

/**
 * Builds cloudflare.config.ts in `mode` in a checkout of its own and reads the output. Mode offline is the dev server's,
 * which vite.config.ts refuses to build; its checkout has a vite config without that gate, and the mark the dev server sets.
 */
function build(mode: "production" | "faults" | "test" | "offline", instance?: string): Built {
	const checkout = join(base, `checkout-${mode}`);
	mkdirSync(checkout);
	for (const entry of readdirSync(ROOT)) {
		if (entry === ".cloudflare" || (mode === "offline" && entry === "vite.config.ts")) continue;
		symlinkSync(join(ROOT, entry), join(checkout, entry));
	}
	if (mode === "offline") writeFileSync(join(checkout, "vite.config.ts"), 'import { cloudflare } from "@cloudflare/vite-plugin";\nexport default { plugins: [cloudflare({ remoteBindings: false })] };\n');
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${join(base, "bin")}:${process.env.PATH}`,
		MINERVA_INSTANCES_DIR: join(base, "instances"),
		MINERVA_INSTANCE: instance,
		MINERVA_SANDBOX_IMAGE: IMAGE,
		MINERVA_MODEL_PRICES: PRICES,
		MINERVA_DEV_OFFLINE: mode === "offline" ? "1" : undefined,
		CLOUDFLARE_API_TOKEN: "invalid",
		CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
	};
	const result = spawnSync(CF, ["build", "--mode", mode], { cwd: checkout, env, encoding: "utf8" });
	expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
	const output = join(checkout, ".cloudflare", "output", "v0", "workers", "default");
	const config = JSON.parse(readFileSync(join(output, "worker.config.json"), "utf8")) as Built["config"];
	const entry = readFileSync(join(output, "bundle", "index.js"), "utf8");
	const exported = /export \{([^}]*)\};\s*$/.exec(entry);
	expect(exported, "the entry ends in one export statement").not.toBeNull();
	const code = (exported?.[1] ?? "")
		.split(",")
		.map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
		.filter((name) => name !== "default");
	return { config, code };
}

/** The build's Durable Object exports by state, and the classes its bindings name. */
function classes({ config }: Built) {
	const objects = Object.entries(config.exports ?? {}).filter(([, entry]) => entry.type === "durable-object");
	return {
		live: objects.filter(([, entry]) => entry.state === undefined).map(([name]) => name).sort(),
		deleted: objects.filter(([, entry]) => entry.state === "deleted").map(([name]) => name).sort(),
		bound: Object.values(config.env).flatMap((binding) => (binding.type === "durable-object" && binding.exportName ? [binding.exportName] : [])).sort(),
	};
}

const namespaces = (...names: string[]) => names.map((name) => ({ class: name }));

test("a production instance's build has no Workspace, and a Workspace namespace is a stray", { timeout: 60_000 }, () => {
	const built = build("production", "acme");
	expect(classes(built)).toEqual({ live: ["Conversation", "Sandbox", "Scripts"], deleted: [], bound: ["Conversation", "Scripts"] });
	expect(built.code.sort()).toEqual(["Conversation", "Sandbox", "Scripts"]);
	expect(strayClasses(namespaces("Conversation", "Scripts", "Sandbox", "Workspace"), built.config)).toEqual(["Workspace"]);
	expect(strayClasses(namespaces("Conversation", "Scripts", "Sandbox"), built.config)).toEqual([]);
	// The prices the deploy read reach the build as a text binding.
	expect(built.config.env.MINERVA_MODEL_PRICES).toEqual({ type: "text", value: PRICES });
});

test("a test instance's build has neither Workspace nor FaultMailbox, and their namespaces are strays", { timeout: 60_000 }, () => {
	const built = build("faults", "acme-test");
	expect(classes(built)).toEqual({ live: ["Conversation", "FaultProvider", "Sandbox", "Scripts"], deleted: [], bound: ["Conversation", "FaultProvider", "Scripts"] });
	expect(built.code.sort()).toEqual(["Conversation", "FaultProvider", "Sandbox", "Scripts"]);
	expect(strayClasses(namespaces("Conversation", "Scripts", "Sandbox", "FaultProvider", "Workspace", "FaultMailbox"), built.config)).toEqual(["FaultMailbox", "Workspace"]);
	expect(strayClasses(namespaces("Conversation", "Scripts", "Sandbox", "FaultProvider"), built.config)).toEqual([]);
});

test("the platform tests' and the dev server's builds have neither class, live or deleted", { timeout: 60_000 }, () => {
	for (const mode of ["test", "offline"] as const) {
		const built = build(mode);
		expect(classes(built), mode).toEqual({ live: ["Conversation", "FaultProvider", "Sandbox", "Scripts"], deleted: [], bound: ["Conversation", "FaultProvider", "Scripts"] });
		expect(built.code.sort(), mode).toEqual(["Conversation", "FaultProvider", "Sandbox", "Scripts"]);
	}
});
