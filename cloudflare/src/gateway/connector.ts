// The connector contract's runtime parts: lookups on a
// declaration, the defaults of an operation, consent, bindings and the owned error. The declaration
// format itself is in contracts/connectors.ts; the registry (registry.ts) checks every declaration.

import type { ConnectionId } from "../contracts/common.ts";
import type {
	ActionSpec,
	Binding,
	Connector,
	Consent,
	ErrorCode,
	Operation,
	OperationErrorShape,
	ProviderClient,
	ResourceKind,
} from "../contracts/connectors.ts";
import type { Resource } from "../contracts/policy.ts";
import { resource } from "./policy.ts";

/** A reserved kind for account-level actions; its one resource id is the connection id. */
export const ACCOUNT_KIND = "account";

/** An owned, deliberately safe error. Only these messages reach the model or the UI. */
export class OperationError extends Error implements OperationErrorShape {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OperationError";
		this.code = code;
	}
}

export const DENIED = "This resource or action is not available under the current permissions.";

/** The refusal of a call the policy does not allow, or of one naming something Minerva will not reveal. */
export function denied(): OperationError {
	return new OperationError("POLICY_DENIED", DENIED);
}

/**
 * An operation declared with its input's type, for a connector's `operations` (`Operation<never>[]`). The
 * cast is the one place the input type is forgotten: zod's schema type is covariant in its output, so no
 * typed schema is a `ZodType<never>`. The executor only ever passes `prepare` what `input` parsed.
 */
export function defineOperation<Input>(op: Operation<Input>): Operation<never> {
	return op as unknown as Operation<never>;
}

export function operationOf(connector: Connector, name: string): Operation<never> | null {
	return connector.operations.find((op) => op.name === name) ?? null;
}

export function actionOf(connector: Connector, id: string): ActionSpec | null {
	return connector.actions.find((action) => action.id === id) ?? null;
}

export function kindOf(connector: Connector, id: string): ResourceKind | null {
	return connector.kinds.find((kind) => kind.id === id) ?? null;
}

export function nests(connector: Connector, kind: string): boolean {
	return kindOf(connector, kind)?.hierarchical ?? false;
}

/** The action an action requires on the same resource, as the policy asks it. */
export function requiresOf(connector: Connector): (action: string) => string | null {
	return (action) => actionOf(connector, action)?.requires ?? null;
}

/** Whether this instance can run the operation at all (`offered`, default true). */
export function offered(connector: Connector, op: Operation<never>): boolean {
	return connector.offered ? connector.offered(op) : true;
}

/** What an operation means beyond its input and needs, with the defaults filled in. */
export interface OperationTerms {
	outputAction: string;
	consent: Consent | null;
	revision: number;
	mutates: boolean;
	paginated: boolean;
}

export function termsOf(op: Operation<never>): OperationTerms {
	return {
		outputAction: op.outputAction ?? "read",
		consent: op.consent ?? null,
		revision: op.revision ?? 1,
		mutates: op.mutates ?? false,
		paginated: op.paginated ?? false,
	};
}

/**
 * Whether the scopes the connection was granted cover the operation: any one set in full. Unknown scopes
 * (null) pass, so the provider is the one to refuse; known but empty ones fail every operation with
 * consent (risk 16).
 */
export function consentGiven(consent: Consent | null | undefined, scopes: readonly string[] | null): boolean {
	if (consent === null || consent === undefined || scopes === null) return true;
	const granted = new Set(scopes);
	return consent.some((option) => option.every((scope) => granted.has(scope)));
}

/** One connection as seen by one call: its id and an authenticated provider client. */
export function binding<Client extends ProviderClient>(connectionId: ConnectionId, client: Client): Binding<Client> {
	return {
		connectionId,
		client,
		resource: (kind: string, id: string, within: string[] = [], partial = false): Resource => resource(connectionId, kind, id, within, partial),
		account: (): Resource => resource(connectionId, ACCOUNT_KIND, connectionId),
	};
}
