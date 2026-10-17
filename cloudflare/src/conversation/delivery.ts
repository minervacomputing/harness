// The delivery of a Laravel conversation's facts (docs/plans/credentials-and-facts.md, Delivered in order): the facts after
// what Laravel acknowledged, in batches, each first raised in the recovery index and then sent with `deliverFacts`; Laravel's
// answer checked rather than trusted; a failure backed off, and a conflict left for the operator. One delivery at a time per
// object. Every read of the store and every change to the delivery's state is its own step outside pi's transactions
// (store.ts `outside`), since pi may open one while the delivery awaits D1 or Laravel.

import type { Fact } from "@minerva/contract/internal";
import { ORPCError } from "@orpc/client";
import { settings } from "../config.ts";
import { raiseFactSeq } from "../internal/recovery.ts";
import { failureOf, laravelClient } from "../laravel/client.ts";
import { parseJson } from "../lib/json.ts";
import { type DeliveryVerdict, FACT_DELIVERY, MAX_FACTS, MAX_GAPS, acknowledgement, backoffMs, gap } from "./facts.ts";
import type { RunStore } from "./store.ts";

/** What a delivery runs against besides the store: the object's `facts` and `retain` jobs, and its log. */
export interface DeliveryHost {
	env: Env;
	/** Makes the `facts` job due at `time`, or removes it; synchronous, so it joins the step that decides it. */
	schedule(time: number | null): void;
	/** Makes the `retain` job due for what was acknowledged at `acknowledgedAt`, moved only earlier; synchronous, as `schedule`. */
	retain(acknowledgedAt: number): void;
	log(message: string, error?: unknown): void;
}

export class FactDelivery {
	readonly #store: RunStore;
	readonly #host: DeliveryHost;
	#running: Promise<void> | null = null;

	constructor(store: RunStore, host: DeliveryHost) {
		this.#store = store;
		this.#host = host;
	}

	/** Delivers what is due, joining a delivery already running; it ends by scheduling the job for what is left. */
	deliver(): Promise<void> {
		this.#running ??= this.#deliver().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	async #deliver(): Promise<void> {
		let gaps = 0;
		for (;;) {
			const due = await this.#store.outside(() => this.#due());
			if (due === null) return;
			const verdict = await this.#send(due.conversation, due.facts, due.last);
			if (verdict.kind === "acknowledged") {
				gaps = 0;
				await this.#store.outside(() =>
					this.#store.write(() => {
						this.#store.acknowledge(verdict.acknowledged);
						this.#host.retain(this.#store.now());
					}),
				);
				continue;
			}
			if (verdict.kind === "gap" && ++gaps <= MAX_GAPS) {
				// Checked again in the step that stores it: retention may have raised the floor since.
				const stopped = await this.#store.outside(() => {
					const { written, floor } = this.#store.delivery();
					const checked = gap(verdict.acknowledged, written, floor);
					if (checked.kind !== "gap") {
						this.#failed(checked);
						return true;
					}
					this.#store.acknowledgeGap(checked.acknowledged);
					return false;
				});
				if (stopped) return;
				continue;
			}
			await this.#store.outside(() => this.#failed(verdict));
			return;
		}
	}

	/**
	 * The next batch, or null once nothing is due: then the job is made due for what is left (a backoff's end), or removed,
	 * in the same step, so a fact written meanwhile has already scheduled it again.
	 */
	#due(): { conversation: { id: string; organization: string; workspace: string }; facts: Fact[]; last: number } | null {
		const conversation = this.#store.conversation();
		if (conversation === null || conversation.organization_id === null) {
			this.#host.schedule(null);
			return null;
		}
		const delivery = this.#store.delivery();
		if (delivery.next_at > this.#store.now()) {
			this.#host.schedule(delivery.next_at);
			return null;
		}
		const page = this.#store.factPage(delivery.acknowledged, MAX_FACTS);
		const last = page.facts.at(-1);
		if (last === undefined) {
			this.#host.schedule(null);
			return null;
		}
		return {
			conversation: { id: conversation.id, organization: conversation.organization_id, workspace: conversation.workspace_id },
			facts: page.facts.map((fact) => parseJson(fact.json) as unknown as Fact),
			last: last.seq,
		};
	}

	/** One batch: the index raised first, then Laravel's answer as a verdict. Never throws. */
	async #send(conversation: { id: string; organization: string; workspace: string }, facts: Fact[], last: number): Promise<DeliveryVerdict> {
		const environment = settings(this.#host.env).internal?.environment ?? null;
		if (environment === null) return { kind: "failed", reason: "The internal API's settings are not set.", error: true };
		const scope = { environment, organization: conversation.organization, workspace: conversation.workspace };
		try {
			const indexed = await this.#store.outside(() => this.#store.delivery().indexed);
			if (last > indexed) {
				if (!(await raiseFactSeq(this.#host.env.DB, { conversation: conversation.id, organization: scope.organization, workspace: scope.workspace, seq: last }))) {
					return { kind: "failed", reason: "The recovery index has no row for this conversation.", error: true };
				}
				await this.#store.outside(() => this.#store.updateDelivery({ indexed: Math.max(last, this.#store.delivery().indexed) }));
			}
		} catch (error) {
			return { kind: "failed", reason: `The recovery index could not be raised: ${message(error)}`, error: false };
		}
		let client: ReturnType<typeof laravelClient>;
		try {
			client = laravelClient(this.#host.env);
		} catch (error) {
			return { kind: "failed", reason: message(error), error: true };
		}
		try {
			const answer = await client.deliverFacts({ scope, conversation: conversation.id, facts });
			return acknowledgement(answer.acknowledged, last, await this.#store.outside(() => this.#store.delivery().written));
		} catch (error) {
			if (error instanceof ORPCError && error.code === "FACT_GAP") {
				const watermark = (error.data as { acknowledged?: unknown } | undefined)?.acknowledged;
				const { written, floor } = await this.#store.outside(() => this.#store.delivery());
				return gap(watermark, written, floor);
			}
			if (error instanceof ORPCError && error.code === "FACT_CONFLICT") return { kind: "conflict" };
			const status = error instanceof ORPCError ? error.status : null;
			return { kind: "failed", reason: `Laravel did not take the facts: ${failureOf(error)}`, error: status !== null && status < 500 };
		}
	}

	/**
	 * A delivery that did not go through: backed off, or for a conflict or facts Laravel lost below the floor, left for the
	 * operator and tried hourly, which resumes by itself once Laravel takes the batch. Below the floor, what was acknowledged
	 * stays, so the next batch does not start at the floor; the marks above what Laravel holds go, so retention keeps the facts
	 * it lacks that are still held.
	 */
	#failed(verdict: DeliveryVerdict): void {
		const now = this.#store.now();
		if (verdict.kind === "pruned") this.#store.forgetAcknowledgements(verdict.acknowledged);
		if (verdict.kind === "conflict" || verdict.kind === "pruned") {
			const reason =
				verdict.kind === "conflict"
					? "Laravel refused a fact that differs from the one it applied (FACT_CONFLICT)."
					: `Laravel lost facts up to the floor ${verdict.floor}, which the engine no longer holds (FACTS_PRUNED).`;
			this.#host.log(`fact delivery stopped for the operator: ${reason}`, new Error(reason));
			const at = now + FACT_DELIVERY.conflictRetryMs;
			this.#store.updateDelivery({ stopped: reason, next_at: at });
			this.#host.schedule(at);
			return;
		}
		const failures = this.#store.delivery().failures + 1;
		const reason = verdict.kind === "failed" ? verdict.reason : "Laravel answered too many gaps in a row.";
		const error = verdict.kind === "failed" ? verdict.error : true;
		this.#host.log(`fact delivery failed (${failures} in a row): ${reason}`, error ? new Error(reason) : undefined);
		const at = now + backoffMs(failures);
		this.#store.updateDelivery({ failures, next_at: at });
		this.#host.schedule(at);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
