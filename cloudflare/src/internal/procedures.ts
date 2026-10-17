// The commands Laravel sends (contract/src/internal/engine.ts), as the engine implements them. Each command that names an
// environment must name this engine's; each declared before its chunk answers 501 `NOT_IMPLEMENTED` until then.

import { engine } from "@minerva/contract/internal";
import { implement } from "@orpc/server";
import { pricesOf } from "../budget/prices.ts";
import { connectorRegistry } from "../connectors/index.ts";
import { catalogOf } from "./catalog.ts";
import { checkGrantEdit, describeAccount, listResources } from "./connections.ts";
import { deleteConversation, readFolder, resolveDownload } from "./conversations.ts";
import { internalRefusal } from "./errors.ts";
import { listIndexed } from "./recovery.ts";
import { cancelRun, replayFacts, startRun } from "./runs.ts";

export interface InternalContext {
	/** The request as it arrived. Its body is read only by handler.ts's reader. */
	request: Request;
	env: Env;
	/** The environment this engine serves (MINERVA_ENVIRONMENT). */
	environment: string;
	/** The service token's client id that the mount verified (internal/access.ts). */
	client: string;
}

const internal = implement(engine).$context<InternalContext>();

/** The environment a command names: its scope's, or its own for `admission` and `listConversations`; undefined when it names none. */
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
	catalog: internal.catalog.handler(async ({ context }) => catalogOf(await connectorRegistry(), await pricesOf(context.env))),
	startRun: internal.startRun.use(inEnvironment).handler(({ context, input }) => startRun(context.env, input)),
	cancelRun: internal.cancelRun.use(inEnvironment).handler(({ context, input }) => cancelRun(context.env, input)),
	replayFacts: internal.replayFacts.use(inEnvironment).handler(({ context, input }) => replayFacts(context.env, input)),
	describeAccount: internal.describeAccount.use(inEnvironment).handler(({ context, input }) => describeAccount(context.env, input)),
	listResources: internal.listResources.use(inEnvironment).handler(({ context, input }) => listResources(context.env, input)),
	checkGrantEdit: internal.checkGrantEdit.use(inEnvironment).handler(({ context, input }) => checkGrantEdit(context.env, input)),
	folder: internal.folder.use(inEnvironment).handler(({ context, input }) => readFolder(context.env, input)),
	resolveDownload: internal.resolveDownload.use(inEnvironment).handler(({ context, input }) => resolveDownload(context.env, input)),
	deleteConversation: internal.deleteConversation.use(inEnvironment).handler(({ context, input }) => deleteConversation(context.env, input)),
	admission: internal.admission.use(inEnvironment).handler(notYet(14)),
	listConversations: internal.listConversations.use(inEnvironment).handler(({ context, input }) => listIndexed(context.env.DB, input)),
});
