// The credentials of a Laravel run. Laravel registers its runs itself and
// reaches the object directly with `startRun` and `cancelRun`, so a stored run is active until a cancel ends it. Laravel
// learns of an end and of usage from the run's facts, and lends each provider call its credential with `leaseToken`, which
// the engine holds in memory for that call only.

import { settings } from "../config.ts";
import type { CredentialPayload } from "../gateway/connector.ts";
import type { CredentialPort, HeldLease } from "../gateway/executor.ts";
import { RUN_ENDED_MESSAGE } from "../gateway/ledger.ts";
import { failureOf, laravelClient, retryable } from "../laravel/client.ts";
import type { AttemptFence } from "../shared/rpc.ts";
import type { RunSnapshot } from "./store.ts";

export const EXPIRED = "The connection expired. Reconnect it in Minerva.";

/** What reaches the model when Laravel cannot lend a credential: never Laravel's own message. */
export const UNAVAILABLE = "This connection is not available to the agent right now. Try again.";

/** A lease whose token expires sooner than this is asked for again, once. */
export const MIN_LEASE_MS = 60_000;
/** The waits before a lease that failed in a way worth retrying is asked for again, while the fence is current. */
export const LEASE_RETRIES_MS = [250, 1000];

export interface LaravelCredentialsContext {
	env: Env;
	/** The conversation's organization and workspace, as it is bound. */
	scope: { organization: string; workspace: string };
	conversation: string;
	snapshot: RunSnapshot;
	isCurrent(fence: AttemptFence): boolean;
	/** For what an operator must look at: never given a secret. */
	log(message: string, error?: unknown): void;
}

type Refusal = { refused: "RUN_ENDED" | "CONNECTION_UNAUTHORIZED" | "PROVIDER_UNAVAILABLE"; message: string };

const ENDED: Refusal = { refused: "RUN_ENDED", message: RUN_ENDED_MESSAGE };
const UNAVAILABLE_REFUSAL: Refusal = { refused: "PROVIDER_UNAVAILABLE", message: UNAVAILABLE };

/** One of Laravel's lease answers, as the executor reads it: the lease, or a refusal with the engine's own message. */
type Answer = { kind: "leased"; lease: HeldLease; expiresAt: number | null } | { kind: "refused"; refusal: Refusal } | { kind: "retry"; error: unknown };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A Laravel run's CredentialPort: `leaseToken` and `reportUnauthorized` through the engine's client of Laravel. */
export function laravelCredentials(context: LaravelCredentialsContext): CredentialPort {
	const providers = new Map(context.snapshot.tools.map((tool) => [tool.connection_id, tool.provider]));
	const scope = () => {
		const environment = settings(context.env).internal?.environment ?? null;
		if (environment === null) throw new Error("The internal API's settings are not set.");
		return { environment, ...context.scope };
	};

	const ask = async (fence: AttemptFence, connection: string): Promise<Answer> => {
		let answer;
		try {
			answer = await laravelClient(context.env).leaseToken({ scope: scope(), conversation: context.conversation, run: fence.runId, attempt: fence.attempt, connection });
		} catch (error) {
			if (retryable(error)) return { kind: "retry", error };
			context.log(`Laravel refused a lease request for connection ${connection}`, new Error(failureOf(error)));
			return { kind: "refused", refusal: UNAVAILABLE_REFUSAL };
		}
		if (answer.outcome === "refused") {
			if (answer.code === "RUN_NOT_ACTIVE") return { kind: "refused", refusal: ENDED };
			if (answer.code === "RECONNECT_NEEDED") return { kind: "refused", refusal: { refused: "CONNECTION_UNAUTHORIZED", message: EXPIRED } };
			// The snapshot authorized the connection: Laravel disagreeing is a bug on one side or the other.
			if (answer.code === "NOT_AUTHORIZED") context.log(`Laravel refused connection ${connection} as not authorized for run ${fence.runId}`);
			return { kind: "refused", refusal: UNAVAILABLE_REFUSAL };
		}
		const lease: HeldLease = {
			connectionId: connection,
			provider: providers.get(connection) ?? "",
			generation: answer.generation,
			scopes: answer.scopes,
			payload: payloadOf(answer.kind, answer.secret, answer.scopes),
		};
		return { kind: "leased", lease, expiresAt: answer.expiresAt === null ? null : Date.parse(answer.expiresAt) };
	};

	return {
		async lease(fence, connection) {
			let renewed = false;
			let retries = 0;
			for (;;) {
				if (!context.isCurrent(fence)) return ENDED;
				const answer = await ask(fence, connection);
				if (!context.isCurrent(fence)) return ENDED;
				if (answer.kind === "refused") return answer.refusal;
				if (answer.kind === "retry") {
					const wait = LEASE_RETRIES_MS[retries++];
					if (wait === undefined) {
						context.log(`Laravel did not lend connection ${connection}`, new Error(failureOf(answer.error)));
						return UNAVAILABLE_REFUSAL;
					}
					await sleep(wait);
					continue;
				}
				// Laravel refreshes before it lends: a token about to lapse is asked for once more, then refused.
				if (answer.expiresAt !== null && answer.expiresAt - Date.now() < MIN_LEASE_MS) {
					if (renewed) {
						context.log(`Laravel lent connection ${connection} a token about to expire`);
						return UNAVAILABLE_REFUSAL;
					}
					renewed = true;
					continue;
				}
				return answer.lease;
			}
		},
		async markUnauthorized(connection, generation, fence) {
			try {
				await laravelClient(context.env).reportUnauthorized({ scope: scope(), conversation: context.conversation, run: fence.runId, attempt: fence.attempt, connection, generation });
			} catch (error) {
				// The executor logs it: its code, or what failed, never a body.
				throw new Error(`Laravel did not take the report: ${failureOf(error)}`);
			}
		},
	};
}

/** The executor's payload for a lent secret: never a refresh token, which stays in Laravel. */
function payloadOf(kind: "oauth2" | "api_key" | "builtin", secret: string, scopes: string[] | null): CredentialPayload {
	if (kind === "api_key") return { kind, key: secret };
	if (kind === "builtin") return { kind };
	return { kind, access_token: secret, refresh_token: null, scopes };
}
