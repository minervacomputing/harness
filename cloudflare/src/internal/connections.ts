// The settings calls Laravel makes with a credential it holds (docs/plans/contract.md, Credentials in settings calls): the
// credential arrives in the command, is used for this call only, and is never stored or logged. A provider's refusal of it
// is `CREDENTIAL_REFUSED`, which Laravel acts on; any other failure is `PROVIDER_FAILED`.

import { type DescribeAccount, type DescribeAccountResult, INTERNAL_REFUSALS } from "@minerva/contract/internal";
import { ORPCError } from "@orpc/server";
import { providerAccount } from "../api/providers.ts";
import { connectorRegistry } from "../connectors/index.ts";
import { type Connector, OperationError } from "../gateway/connector.ts";
import { unauthorized } from "../gateway/executor.ts";
import type { WorkspaceRef } from "../shared/rpc.ts";
import { internalRefusal } from "./errors.ts";

/** The connector a settings call names, if its credential is of the connector's kind. */
async function connectorFor(command: DescribeAccount): Promise<Connector> {
	const connector = (await connectorRegistry()).find(command.connection.provider);
	if (connector === null) throw internalRefusal("NOT_FOUND", "This engine has no such connector.");
	if (connector.auth.type !== command.credential.kind) {
		const message = `credential.kind: ${connector.name} takes a credential of the kind ${connector.auth.type}.`;
		const issues = [{ path: ["credential", "kind"], message, code: "custom" }];
		throw new ORPCError("VALIDATION_FAILED", { defined: true, status: INTERNAL_REFUSALS.VALIDATION_FAILED, message, data: { issues } });
	}
	return connector;
}

/** The provider refused the credential: a refusal at the call (`unauthorized`), or a key a connector refuses itself (Stripe's). */
function refusedCredential(error: OperationError): boolean {
	return unauthorized(error) || error.code === "INVALID_KEY";
}

/** The workspace a settings call's provider requests are made for. Laravel's conversations, and so its workspaces, are in the EU. */
function workspaceOf(command: DescribeAccount): WorkspaceRef {
	return { id: command.scope.workspace, jurisdiction: "eu" };
}

/** The account behind the credential. Its tenant is unknown until connection policies (product-and-engine.md, chunk 17). */
export async function describeAccount(env: Env, command: DescribeAccount): Promise<DescribeAccountResult> {
	const connector = await connectorFor(command);
	try {
		const account = await providerAccount(env, workspaceOf(command), connector, command.credential.secret);
		return { outcome: "described", account: { id: account.id, label: account.label, tenant: null } };
	} catch (error) {
		if (!(error instanceof OperationError)) throw error;
		if (refusedCredential(error)) return { outcome: "refused", code: "CREDENTIAL_REFUSED", message: error.message };
		return { outcome: "refused", code: "PROVIDER_FAILED", message: error.message };
	}
}
