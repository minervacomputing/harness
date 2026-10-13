// The one place that maps a workspace to its Durable Objects and its bucket (plan: Data placement,
// Addressing). The workspace's id and jurisdiction come from D1, never from the client: the same name with
// and without a jurisdiction is a different, empty object. Objects are named by the workspace's or
// conversation's id and reached only by typed RPC from our own code; there are no generic routes to them.
//
// Local workerd has no jurisdictions (`jurisdiction()` throws "Jurisdiction restrictions are not
// implemented in workerd."). With MINERVA_DEBUG on, and only then, such an object is named
// `<jurisdiction>:<name>` in the plain namespace instead, so local runs and platform tests still keep it
// apart from the unqualified one. A production build refuses MINERVA_DEBUG (cloudflare.config.ts), so a
// deployed Worker never falls back. The account tests check the real jurisdictions (`/api/probe`).

import { settings, type SettingsEnv } from "./config.ts";
import type { Conversation } from "./conversation/conversation.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import type { Scripts } from "./scripts/scripts.ts";
import type { ConversationId, WorkspaceRef } from "./shared/rpc.ts";
import type { Workspace } from "./workspace/workspace.ts";

function object<T extends Rpc.DurableObjectBranded>(env: SettingsEnv, binding: unknown, workspace: WorkspaceRef, name: string): DurableObjectStub<T> {
	// A binding to the Worker's own class is typed without its class; this is where it gets it back.
	const namespace = binding as DurableObjectNamespace<T>;
	if (!workspace.jurisdiction) return namespace.getByName(name);
	let qualified: DurableObjectNamespace<T>;
	try {
		qualified = namespace.jurisdiction(workspace.jurisdiction);
	} catch (error) {
		if (!settings(env).debug) throw error;
		return namespace.getByName(`${workspace.jurisdiction}:${name}`);
	}
	return qualified.getByName(name);
}

export function workspaceObject(env: Env, workspace: WorkspaceRef): DurableObjectStub<Workspace> {
	return object<Workspace>(env, env.WORKSPACE, workspace, workspace.id);
}

export function conversationObject(env: Env, workspace: WorkspaceRef, conversation: ConversationId): DurableObjectStub<Conversation> {
	return object<Conversation>(env, env.CONVERSATION, workspace, conversation);
}

export function scriptsObject(env: Env, workspace: WorkspaceRef, conversation: ConversationId): DurableObjectStub<Scripts> {
	return object<Scripts>(env, env.SCRIPTS, workspace, conversation);
}

/** The Sandbox class has no binding (a container class cannot be bound by its own Worker's name): it is reached through `ctx.exports`. */
export function sandboxObject(
	env: Env,
	exports: Cloudflare.Exports,
	workspace: WorkspaceRef,
	conversation: ConversationId,
): DurableObjectStub<Sandbox> {
	return object<Sandbox>(env, exports.Sandbox, workspace, conversation);
}

/**
 * The bucket that keeps the workspace's files: an EU workspace's blobs and uploads stay in
 * `minerva-cf-files-eu`, created in R2's EU jurisdiction, and every other workspace's in `minerva-cf-files`.
 * Keys are the same in both (plan: Data placement).
 */
export function filesBucket(env: Env, workspace: WorkspaceRef): R2Bucket {
	return workspace.jurisdiction === "eu" ? env.FILES_EU : env.FILES;
}
