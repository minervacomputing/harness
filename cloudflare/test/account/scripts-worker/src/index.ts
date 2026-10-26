// The code-mode lab, deployed as the test instance's lab for test/account/scripts.test.ts (cloudflare.config.ts
// here), and deleted after: production's Scripts object and conversation-side runner (src/scripts/), behind
// `Lab`, a stand-in for the Conversation Durable Object with the run's queue (4 at once, writes one at a
// time) in front of fake tools that record what they did in its SQLite.
//
// To compare the two teardowns the spikes disagreed on, the lab also has the Scripts object loading guests
// through an awaited loopback WorkerEntrypoint (`ScriptHost`) instead of itself, and either kind without
// resetting itself on a stop (`…Keep`); the lab can also skip the reset after each script. A driver at
// POST /lab/<op> answers only with `X-Minerva-CM: <CM_TOKEN>`.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ToolQueue } from "../../../../src/conversation/queue.ts";
import type { ToolCallOutcome, ToolDeclaration } from "../../../../src/gateway/executor.ts";
import { type Json, parseJson } from "../../../../src/lib/json.ts";
import { uuid7 } from "../../../../src/lib/random.ts";
import type { GuestOutcome } from "../../../../src/scripts/outcome.ts";
import { executeScript, ScriptLane, type ScriptResult, type ScriptsClient } from "../../../../src/scripts/run.ts";
import { runGuest, type ScriptFence, type ScriptRequest, Scripts as BaseScripts } from "../../../../src/scripts/scripts.ts";
import { ScriptCalls, ScriptSession } from "../../../../src/scripts/session.ts";
import { type ScriptTools, targetsOf } from "../../../../src/scripts/target.ts";
import { render } from "../../../../src/scripts/tool.ts";
import type { AttemptFence } from "../../../../src/shared/rpc.ts";

interface LabEnv {
	LOADER: WorkerLoader;
	CM_TOKEN: string;
}

type Kind = "Scripts" | "ScriptsKeep" | "ScriptsViaHost" | "ScriptsViaHostKeep";

interface LabExports {
	Lab: DurableObjectNamespace<Lab>;
	Scripts: DurableObjectNamespace<Scripts>;
	ScriptsKeep: DurableObjectNamespace<Scripts>;
	ScriptsViaHost: DurableObjectNamespace<Scripts>;
	ScriptsViaHostKeep: DurableObjectNamespace<Scripts>;
	ScriptHost: ScriptHost;
}

/** The loopback entrypoint of the variants that do not load guests themselves. */
export class ScriptHost extends WorkerEntrypoint<LabEnv> {
	async run(script: ScriptRequest, tools: ScriptTools): Promise<GuestOutcome> {
		return await runGuest(this.env.LOADER, script, tools);
	}
}

const INSTANCE = () => crypto.randomUUID();

/** Production's Scripts object, with what the lab asks of it. */
export class Scripts extends BaseScripts {
	readonly #instance = INSTANCE();

	/** This instance's id: a reset gives the next call a new one. */
	async instance(): Promise<string> {
		return this.#instance;
	}

	/** Whether a fresh guest still loads here: ten that never ended take every slot. */
	async probe(): Promise<{ ok: boolean; error?: string }> {
		try {
			const worker = (this.env as unknown as LabEnv).LOADER.load({
				compatibilityDate: "2026-10-06",
				mainModule: "m.js",
				modules: { "m.js": 'import { WorkerEntrypoint } from "cloudflare:workers"; export default class extends WorkerEntrypoint { hi() { return 1; } }' },
				globalOutbound: null,
			});
			await (worker.getEntrypoint() as unknown as { hi(): Promise<number> }).hi();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

/** Does not reset itself on a stop. */
export class ScriptsKeep extends Scripts {
	protected override selfReset(): void {}
}

/** Loads guests through the awaited loopback entrypoint. */
export class ScriptsViaHost extends Scripts {
	protected override async load(script: ScriptRequest, tools: ScriptTools): Promise<GuestOutcome> {
		return await (this.ctx.exports as unknown as LabExports).ScriptHost.run(script, tools);
	}
}

export class ScriptsViaHostKeep extends ScriptsViaHost {
	protected override selfReset(): void {}
}

const RESULT_SCHEMA: { [key: string]: Json } = {
	type: "object",
	properties: { items: { type: "array", items: { type: "object" } }, count: { type: "integer" } },
	required: ["items", "count"],
	additionalProperties: false,
};

function declaration(name: string, write: boolean, properties: { [key: string]: Json }): ToolDeclaration {
	return {
		name,
		title: name,
		description: name,
		inputSchema: { type: "object", properties, additionalProperties: false },
		outputSchema: RESULT_SCHEMA,
		annotations: { readOnlyHint: !write },
	};
}

export const LAB_TOOLS: ToolDeclaration[] = [
	declaration("lab_sleep", false, { ms: { type: "integer" }, tag: { type: "string" } }),
	declaration("lab_tick", false, { tag: { type: "string" } }),
	declaration("lab_fail", false, {}),
	declaration("lab_write", true, { key: { type: "string" }, ms: { type: "integer" } }),
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScriptInput {
	code: string;
	scripts?: Kind;
	/** The Scripts object's name. */
	name?: string;
	/** Reset the Scripts object after each script (production does). */
	reset?: boolean;
	timeoutMs?: number;
	cpuMs?: number;
	runId?: string;
	attempt?: number;
	store?: [string, string][];
}

export class Lab extends DurableObject<LabEnv> {
	readonly #queue = new ToolQueue();
	readonly #calls = new ScriptCalls();
	readonly #lane = new ScriptLane();
	readonly #sessions = new Map<string, ScriptSession>();
	#inFlight = 0;
	#maxInFlight = 0;

	constructor(ctx: DurableObjectState, env: LabEnv) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL)");
	}

	#record(kind: string, tag: string): void {
		this.ctx.storage.sql.exec("INSERT INTO events (kind, tag, at) VALUES (?, ?, ?)", kind, tag, Date.now());
	}

	async #tool(name: string, args: Json | undefined): Promise<ToolCallOutcome> {
		const input = (args ?? {}) as { ms?: number; tag?: string; key?: string };
		const ok = (items: { [key: string]: Json }[]): ToolCallOutcome => ({ ok: true, result: { items, count: items.length }, images: [], title: name, repeat: false, writeKey: null, event: null });
		this.#inFlight++;
		this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
		try {
			if (name === "lab_sleep") {
				this.#record("sleep:start", String(input.tag ?? ""));
				await sleep(Number(input.ms ?? 100));
				this.#record("sleep:end", String(input.tag ?? ""));
				return ok([{ ms: Number(input.ms ?? 100), tag: String(input.tag ?? "") }]);
			}
			if (name === "lab_tick") {
				this.#record("tick", String(input.tag ?? ""));
				return ok([]);
			}
			if (name === "lab_write") {
				this.#record("write:start", String(input.key ?? ""));
				await sleep(Number(input.ms ?? 100));
				this.#record("write:applied", String(input.key ?? ""));
				return ok([{ key: String(input.key ?? "") }]);
			}
			return { ok: false, error: { code: "FAILED", message: "The provider refused the request (HTTP 403)." }, event: null };
		} finally {
			this.#inFlight--;
		}
	}

	/** One call through the queue; its outcome is recorded when it settles, whoever still waits (as `#invoke` records its event). */
	#invoke(tool: ToolDeclaration, args: Json | undefined, drop: AbortSignal): Promise<ToolCallOutcome> {
		const call = this.#queue.send(tool.annotations.readOnlyHint !== true, () => this.#tool(tool.name, args), () => drop.throwIfAborted());
		const recorded = call.then(
			(outcome) => this.#record("recorded", `${tool.name}:${outcome.ok ? "ok" : "error"}`),
			() => this.#record("dropped", tool.name),
		);
		this.ctx.waitUntil(recorded);
		return call;
	}

	#scripts(kind: Kind, name: string): ScriptsClient {
		return (this.ctx.exports as unknown as LabExports)[kind].getByName(name) as unknown as ScriptsClient;
	}

	async script(input: ScriptInput): Promise<{ result: ScriptResult; model: unknown; ms: number; session: string; maxInFlight: number }> {
		const kind = input.scripts ?? "Scripts";
		// By default each lab has a Scripts object of its own.
		const name = input.name ?? this.ctx.id.name ?? "lab";
		const fence: AttemptFence = { runId: input.runId ?? uuid7(), attempt: input.attempt ?? 1 };
		const tools = new Map(LAB_TOOLS.map((tool) => [tool.name, tool]));
		const session = uuid7();
		this.#maxInFlight = 0;
		const started = Date.now();
		const result = await executeScript({
			fence: { ...fence, scriptId: session },
			code: input.code,
			tools,
			store: input.store ?? [],
			timeoutMs: input.timeoutMs ?? 120_000,
			cpuMs: input.cpuMs ?? 30_000,
			calls: this.#calls,
			port: { invoke: (tool, args, drop) => this.#invoke(tool, args, drop) },
			scripts: () => {
				const client = this.#scripts(kind, name);
				return input.reset === false ? { run: (f, s, t, c) => client.run(f, s, t, c), reset: async () => ({ reset: true as const }) } : client;
			},
			lane: this.#lane,
			targets: (state) => targetsOf(state),
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			onSession: (state) => this.#sessions.set(session, state),
		});
		const model = await render(result, async () => undefined);
		return { result, model, ms: Date.now() - started, session, maxInFlight: this.#maxInFlight };
	}

	/** Starts a script and answers at once; `dieAfterMs` later this object resets itself, as a crashed conversation would. */
	async start(input: ScriptInput, dieAfterMs: number): Promise<{ session: string }> {
		const script = this.script(input);
		this.ctx.waitUntil(script.catch(() => {}));
		this.ctx.waitUntil(
			sleep(dieAfterMs).then(() => {
				this.ctx.abort("The lab was reset.");
			}),
		);
		await sleep(10);
		return { session: [...this.#sessions.keys()].at(-1) ?? "" };
	}

	ping(): number {
		return Date.now();
	}

	late(session: string): { late: number; open: number; pending: number } | null {
		const state = this.#sessions.get(session);
		return state ? { late: state.late, open: this.#calls.open, pending: state.pending() } : null;
	}

	events(): { kind: string; tag: string; at: number }[] {
		return this.ctx.storage.sql.exec<{ kind: string; tag: string; at: number }>("SELECT kind, tag, at FROM events ORDER BY seq").toArray();
	}

	async probe(kind: Kind, name: string): Promise<unknown> {
		return await (this.#scripts(kind, name) as unknown as Scripts).probe();
	}

	async instance(kind: Kind, name: string): Promise<string> {
		return await (this.#scripts(kind, name) as unknown as Scripts).instance();
	}

	async reset(kind: Kind, name: string, runId: string, attempt: number, scriptId: string): Promise<unknown> {
		try {
			return await this.#scripts(kind, name).reset({ runId, attempt, scriptId });
		} catch (error) {
			return { thrown: error instanceof Error ? error.message : String(error), durableObjectReset: (error as { durableObjectReset?: unknown }).durableObjectReset === true };
		}
	}

	/** A raw run on the Scripts object, for its fences: `{ refused }`, its answer, or what it threw. */
	async raw(kind: Kind, name: string, fence: ScriptFence, code: string): Promise<unknown> {
		const tools = new Map(LAB_TOOLS.map((tool) => [tool.name, tool]));
		const state = new ScriptSession(this.#calls, tools, { invoke: (tool, args, drop) => this.#invoke(tool, args, drop) });
		const { tools: target, control } = targetsOf(state);
		try {
			return await this.#scripts(kind, name).run(fence, { code, tools: LAB_TOOLS.map((tool) => ({ name: tool.name, identifier: tool.name })), store: [], cpuMs: 30_000 }, target, control);
		} catch (error) {
			return { thrown: error instanceof Error ? error.message : String(error) };
		}
	}
}

async function same(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
	return crypto.subtle.timingSafeEqual(x, y);
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const labEnv = env as unknown as LabEnv;
		const token = request.headers.get("X-Minerva-CM") ?? "";
		if (!labEnv.CM_TOKEN || !(await same(token, labEnv.CM_TOKEN))) return json({ detail: "Not Found" }, 404);
		const url = new URL(request.url);
		const body = (request.method === "POST" ? parseJson(await request.text()) : {}) as { [key: string]: Json };
		const lab = (ctx.exports as unknown as LabExports).Lab.getByName(String(body.lab ?? "lab"));
		const kind = (body.scripts as Kind | undefined) ?? "Scripts";
		const name = String(body.name ?? body.lab ?? "lab");
		try {
			switch (url.pathname) {
				case "/lab/script":
					return json(await lab.script(body.input as unknown as ScriptInput));
				case "/lab/start":
					return json(await lab.start(body.input as unknown as ScriptInput, Number(body.dieAfterMs ?? 1000)));
				case "/lab/ping":
					{
						// Measured here, so the test's own network does not count.
						const started = Date.now();
						const at = await lab.ping();
						return json({ at, rpcMs: Date.now() - started });
					}
				case "/lab/late":
					return json(await lab.late(String(body.session)));
				case "/lab/events":
					return json(await lab.events());
				case "/lab/probe":
					return json(await lab.probe(kind, name));
				case "/lab/instance":
					return json({ instance: await lab.instance(kind, name) });
				case "/lab/reset":
					return json(await lab.reset(kind, name, String(body.runId), Number(body.attempt), String(body.scriptId ?? "")));
				case "/lab/raw":
					return json(await lab.raw(kind, name, body.fence as unknown as ScriptFence, String(body.code)));
				default:
					return json({ detail: "Not Found" }, 404);
			}
		} catch (error) {
			return json({ thrown: error instanceof Error ? error.message : String(error) }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
