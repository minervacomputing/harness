// The test build's Sandbox (src/faults/): production's class (src/sandbox/sandbox.ts) with the seams the
// account tests need for the Sandbox row of ARCHITECTURE.md's Testing table, reachable only through the test build's token-gated driver
// (lab.ts, and routes.ts for a conversation's Sandbox): faults in its container port (a hardening step that fails,
// destroys that fail, a restored container's seed that leaves a stray file), a shorter limit for file operations
// and a shorter parked window, a reset of the object that leaves its container running, a root shell for the tests'
// checks, and whether the container runs. Never part of the production Worker.

import { parseJson } from "../lib/json.ts";
import { AGENT_CGROUP, WORKSPACE } from "../sandbox/constants.ts";
import { SEED } from "../sandbox/hardening.ts";
import { runRoot } from "../sandbox/process.ts";
import { Sandbox, objectPorts } from "../sandbox/sandbox.ts";
import type { ContainerPort, SandboxPorts } from "../sandbox/ports.ts";

export interface SandboxFaults {
	/** The hardening step that fails (`workspace`, `tmp`, `home_dirs`, `cgroup`, `readonly_root`). */
	failHardeningAt?: string | null;
	/** How many destroys fail before one goes through. */
	failDestroys?: number;
	/** A file operation's limit in seconds, shorter than production's so a FIFO's read ends soon. */
	fileSeconds?: number;
	/** How long a container stays parked before it retires, shorter than production's so a test reaches the retire soon. */
	parkedMs?: number;
	/** A restored container's seed also writes a file of root's into the folder, so the folder fails its check. */
	straySeed?: boolean;
}

const TABLE = "CREATE TABLE IF NOT EXISTS fault_sandbox (id INTEGER PRIMARY KEY, value TEXT NOT NULL)";

export class FaultSandbox extends Sandbox {
	#faults(): SandboxFaults {
		const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM fault_sandbox WHERE id = 1").toArray()[0];
		return row ? (parseJson(row.value) as SandboxFaults) : {};
	}

	#setFaults(faults: SandboxFaults): void {
		this.ctx.storage.sql.exec("INSERT INTO fault_sandbox (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value", JSON.stringify(faults));
	}

	protected override ports(): SandboxPorts {
		this.ctx.storage.sql.exec(TABLE);
		const base = objectPorts(this.ctx, this.env);
		const real = base.container;
		if (!real) return base;
		const container: ContainerPort = {
			get running() {
				return real.running;
			},
			get image() {
				return real.image;
			},
			start: (options) => real.start(options),
			exec: (argv, options) => {
				const faults = this.#faults();
				const step = faults.failHardeningAt;
				const script = argv[2];
				// The hardening is one root script of named steps: a `false` after the named one fails it there.
				if (step && argv[0] === "/bin/bash" && typeof script === "string" && script.includes("step readonly_root")) {
					return real.exec([argv[0], argv[1] as string, script.replace(`step ${step}\n`, `step ${step}\nfalse\n`), ...argv.slice(3)], options);
				}
				if (faults.straySeed && argv[0] === "/bin/bash" && script === SEED) {
					return real.exec([argv[0], argv[1] as string, `${SEED}\necho stray > ${WORKSPACE}/stray.txt`, ...argv.slice(3)], options);
				}
				return real.exec(argv, options);
			},
			destroy: async (reason) => {
				const faults = this.#faults();
				if ((faults.failDestroys ?? 0) > 0) {
					this.#setFaults({ ...faults, failDestroys: (faults.failDestroys ?? 0) - 1 });
					throw new Error("destroy failed (injected by the test build)");
				}
				await real.destroy(reason);
			},
			setInactivityTimeout: (ms) => real.setInactivityTimeout(ms),
			snapshot: (name) => real.snapshot(name),
		};
		const faults = () => this.#faults();
		return {
			...base,
			container,
			get fileSeconds() {
				return faults().fileSeconds;
			},
			get parkedMs() {
				return faults().parkedMs;
			},
		};
	}

	async faultSet(faults: SandboxFaults): Promise<void> {
		this.ctx.storage.sql.exec(TABLE);
		this.#setFaults(faults);
	}

	/** Resets the object: its in-memory state and exec handles are lost, its container keeps running. */
	async faultAbort(): Promise<void> {
		this.ctx.abort("fault: the sandbox was reset by the test build");
	}

	async faultRoot(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const container = objectPorts(this.ctx, this.env).container;
		if (!container) throw new Error("This Worker has no container.");
		return runRoot({ container, cgroup: AGENT_CGROUP }, ["/bin/bash", "-c", script], { timeoutMs: 60_000 });
	}

	async faultRunning(): Promise<boolean> {
		return this.ctx.container?.running ?? false;
	}
}
