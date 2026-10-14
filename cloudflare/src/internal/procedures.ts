// The commands Laravel sends (contract/src/internal/engine.ts), as the engine implements them. Each command that names an
// environment must name this engine's; each declared before its chunk answers 501 `NOT_IMPLEMENTED` until then.

import { INTERNAL_REFUSALS, type InternalRefusalCode, engine } from "@minerva/contract/internal";
import { ORPCError, implement } from "@orpc/server";
import { connectorRegistry } from "../connectors/index.ts";
import { catalogOf } from "./catalog.ts";

export interface InternalContext {
	/** The request as it arrived. Its body is read only by api/orpc.ts's reader. */
	request: Request;
	env: Env;
	/** The environment this engine serves (MINERVA_ENVIRONMENT). */
	environment: string;
	/** The service token's client id that the mount verified (internal/access.ts). */
	client: string;
}

const internal = implement(engine).$context<InternalContext>();

/** A refusal as the internal contract declares it. */
export function internalRefusal(code: InternalRefusalCode, message: string): ORPCError<InternalRefusalCode, undefined> {
	return new ORPCError(code, { defined: true, status: INTERNAL_REFUSALS[code], message });
}

/** The environment a command names: its scope's, or its own for `admission`; undefined when it names none. */
function namedEnvironment(input: unknown): unknown {
	if (typeof input !== "object" || input === null) return undefined;
	const { scope, environment } = input as { scope?: unknown; environment?: unknown };
	if (typeof scope === "object" && scope !== null) return (scope as { environment?: unknown }).environment;
	return environment;
}

/** A command for another environment is refused before anything else looks at it. */
const inEnvironment = internal.middleware(async ({ context, next }, input: unknown) => {
	const named = namedEnvironment(input);
	if (named !== context.environment) throw internalRefusal("WRONG_ENVIRONMENT", `This engine serves the environment ${context.environment}.`);
	return next();
});

/** A command declared before the chunk that implements it. */
function notYet(chunk: number): () => never {
	return () => {
		throw internalRefusal("NOT_IMPLEMENTED", `This engine does not carry out this command yet (product-and-engine.md, chunk ${chunk}).`);
	};
}

export const internalRouter = internal.router({
	catalog: internal.catalog.handler(async () => catalogOf(await connectorRegistry())),
	startRun: internal.startRun.use(inEnvironment).handler(notYet(6)),
	cancelRun: internal.cancelRun.use(inEnvironment).handler(notYet(6)),
	replayFacts: internal.replayFacts.use(inEnvironment).handler(notYet(7)),
	describeAccount: internal.describeAccount.use(inEnvironment).handler(notYet(9)),
	listResources: internal.listResources.use(inEnvironment).handler(notYet(11)),
	checkGrantEdit: internal.checkGrantEdit.use(inEnvironment).handler(notYet(11)),
	folder: internal.folder.use(inEnvironment).handler(notYet(12)),
	resolveDownload: internal.resolveDownload.use(inEnvironment).handler(notYet(12)),
	deleteConversation: internal.deleteConversation.use(inEnvironment).handler(notYet(12)),
	admission: internal.admission.use(inEnvironment).handler(notYet(14)),
});
