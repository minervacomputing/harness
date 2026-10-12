// The Sandbox Durable Object (contracts/sandbox.ts SandboxApi): one per conversation, with the container
// cloudflare.config.ts gives its class (cloudflare/container/: `durable_object` scheduling, no route out,
// no outbound intercepts, nothing secret in its environment). It is reached as `ctx.exports.Sandbox`, since
// a container class cannot be bound by its own Worker's name (src/addressing.ts). The logic is core.ts's;
// this file gives it the object's container, storage, alarm and the workspace's bucket.

import { DurableObject } from "cloudflare:workers";
import { filesBucket } from "../addressing.ts";
import type { AttemptFence } from "../contracts/common.ts";
import type {
	CheckpointUploadPlan,
	CheckpointUploadResult,
	ExecOutputSink,
	ExecRequest,
	ExecResult,
	FsRequest,
	FsResponse,
	HardeningReport,
	HydratePlan,
	HydrateResult,
	Refused,
	SandboxApi,
	SandboxFence,
	SandboxSpec,
	SandboxStatus,
	ScanResult,
	VerificationReport,
} from "../contracts/sandbox.ts";
import { type About, identity } from "../lib/about.ts";
import { uuid7 } from "../lib/random.ts";
import { durableSql } from "../lib/sql.ts";
import { appliedMigrations, migrate } from "../lib/sqlite.ts";
import { SandboxCore } from "./core.ts";
import { type ContainerPort, r2Bucket, type SandboxPorts } from "./ports.ts";
import { SANDBOX_MIGRATIONS } from "./store.ts";

/** The ports of a Sandbox object: its container (with the image it was given), storage, alarm and buckets. */
export function objectPorts(ctx: DurableObjectState, env: Env, overrides: Partial<SandboxPorts> = {}): SandboxPorts {
	const container = ctx.container;
	const port: ContainerPort | null = container
		? {
				get running() {
					return container.running;
				},
				start(options) {
					const image = container.images.base;
					container.start({ ...options, ...(image ? { image } : {}) } as ContainerStartupOptions);
				},
				exec: (argv, options) => container.exec(argv, options),
				destroy: (reason) => container.destroy(reason),
				setInactivityTimeout: (ms) => container.setInactivityTimeout(ms),
			}
		: null;
	return {
		container: port,
		sql: durableSql(ctx.storage),
		bucket: (workspace) => r2Bucket(filesBucket(env, workspace)),
		now: () => Date.now(),
		id: () => uuid7(),
		alarm: async (at) => {
			if (at === null) await ctx.storage.deleteAlarm();
			else await ctx.storage.setAlarm(at);
		},
		background: (work) => ctx.waitUntil(work),
		log: (message, fields = {}) => console.log(JSON.stringify({ message, sandbox: ctx.id.toString(), ...fields })),
		...overrides,
	};
}

export class Sandbox extends DurableObject<Env> implements SandboxApi {
	protected core!: SandboxCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			migrate(ctx.storage, SANDBOX_MIGRATIONS);
			this.core = new SandboxCore(this.ports());
			await this.core.recover();
		});
	}

	/** The object's ports; the account tests' lab overrides some to inject faults. */
	protected ports(): SandboxPorts {
		return objectPorts(this.ctx, this.env);
	}

	async about(): Promise<About<"sandbox">> {
		return { kind: "sandbox", ...identity(this.ctx), migrations: appliedMigrations(this.ctx.storage) };
	}

	async start(fence: AttemptFence, spec: SandboxSpec): Promise<{ incarnation: string } | Refused | { failed: string }> {
		return this.core.start(fence, spec);
	}

	async harden(fence: SandboxFence): Promise<HardeningReport | Refused> {
		return this.core.harden(fence);
	}

	async verify(fence: SandboxFence): Promise<VerificationReport | Refused> {
		return this.core.verify(fence);
	}

	async exec(fence: SandboxFence, request: ExecRequest, sink: ExecOutputSink | null): Promise<ExecResult | Refused> {
		return this.core.exec(fence, request, sink);
	}

	async cancel(fence: SandboxFence, execId: string): Promise<void> {
		return this.core.cancel(fence, execId);
	}

	async fs(fence: SandboxFence, request: FsRequest): Promise<FsResponse | Refused> {
		return this.core.fs(fence, request);
	}

	async hydrate(fence: SandboxFence, plan: HydratePlan): Promise<HydrateResult | Refused> {
		return this.core.hydrate(fence, plan);
	}

	async scan(fence: SandboxFence, options: { rehashAll: boolean }): Promise<ScanResult | Refused> {
		return this.core.scan(fence, options);
	}

	async checkpoint(fence: SandboxFence, plan: CheckpointUploadPlan): Promise<CheckpointUploadResult | Refused> {
		return this.core.checkpoint(fence, plan);
	}

	async killStrays(fence: SandboxFence): Promise<{ ok: true } | { ok: false; message: string } | Refused> {
		return this.core.killStrays(fence);
	}

	async destroy(fence: SandboxFence, reason: string): Promise<{ destroyed: boolean } | Refused> {
		return this.core.destroy(fence, reason);
	}

	async status(): Promise<SandboxStatus> {
		return this.core.status();
	}

	async alarm(): Promise<void> {
		await this.core.alarm();
	}
}
